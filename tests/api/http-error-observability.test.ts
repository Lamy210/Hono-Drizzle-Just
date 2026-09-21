import { expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../../src/core/errors/app-error";
import type { Meter } from "../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  TelemetryAttributeValue,
  Tracer,
} from "../../src/core/observability/tracer";
import type { TraceContext } from "../../src/core/tracing/trace-context";
import { createErrorHandler } from "../../src/http/error-handler";
import type { AppEnv } from "../../src/http/env";
import { createRequestContextMiddleware } from "../../src/http/middleware/request-context.middleware";
import { normalizeDatabaseError } from "../../src/infrastructure/database/database-error";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";

class RecordingSpan implements Span {
  readonly attributes = new Map<string, TelemetryAttributeValue>();
  status: "ok" | "error" | undefined;

  setAttribute(name: string, value: TelemetryAttributeValue): void {
    this.attributes.set(name, value);
  }

  setStatus(status: "ok" | "error"): void {
    this.status = status;
  }

  recordException(): void {}

  traceContext(): TraceContext {
    return {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "01",
    };
  }
}

class RecordingTracer implements Tracer {
  readonly spans: RecordingSpan[] = [];

  async withSpan<T>(
    _name: string,
    _options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = new RecordingSpan();
    this.spans.push(span);
    return operation(span);
  }
}

class RecordingMeter implements Meter {
  readonly counters: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];
  readonly histograms: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.counters.push({ name, value, ...(attributes === undefined ? {} : { attributes }) });
  }

  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.histograms.push({ name, value, ...(attributes === undefined ? {} : { attributes }) });
  }
}

function createObservedApp() {
  const tracer = new RecordingTracer();
  const meter = new RecordingMeter();
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({ service: "test" }, (line) => lines.push(line));
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, undefined, { tracer, meter }));
  app.onError(createErrorHandler());

  return { app, tracer, meter, lines };
}

test("handled 4xx AppError keeps server span unset and logs a warning without stack details", async () => {
  const { app, tracer, meter, lines } = createObservedApp();
  app.get("/client-error", () => {
    throw new AppError("VALIDATION_ERROR", "Client payload rejected", 400, [
      { path: "email", code: "custom", message: "invalid client value" },
    ]);
  });

  const response = await app.request("/client-error");

  expect(response.status).toBe(400);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.status).toBeUndefined();
  expect(tracer.spans[0]?.attributes.get("http.response.status_code")).toBe(400);
  expect(meter.counters[0]?.attributes).toMatchObject({ status_code: 400 });

  expect(lines).toHaveLength(1);
  const log = JSON.parse(lines[0] ?? "{}");
  expect(log).toMatchObject({
    level: "warn",
    message: "http.request.rejected",
    errorCode: "VALIDATION_ERROR",
    statusCode: 400,
    method: "GET",
    path: "/client-error",
  });
  expect(log.error).toBeUndefined();
  expect(lines[0]).not.toContain("invalid client value");
});

test("5xx AppError marks the server span as error and keeps exception diagnostics", async () => {
  const { app, tracer, meter, lines } = createObservedApp();
  app.get("/server-error", () => {
    throw new AppError("INTERNAL_ERROR", "Internal server error", 500, undefined, {
      cause: new Error("database unavailable"),
    });
  });

  const response = await app.request("/server-error");

  expect(response.status).toBe(500);
  expect(tracer.spans[0]?.status).toBe("error");
  expect(tracer.spans[0]?.attributes.get("http.response.status_code")).toBe(500);
  expect(meter.counters[0]?.attributes).toMatchObject({ status_code: 500 });

  const log = JSON.parse(lines[0] ?? "{}");
  expect(log).toMatchObject({
    level: "error",
    message: "http.request.error",
    errorCode: "INTERNAL_ERROR",
    statusCode: 500,
  });
  expect(log.error).toMatchObject({ name: "AppError", message: "Internal server error" });
});

test("unknown exceptions are normalized to 500 and classified as server failures", async () => {
  const { app, tracer, lines } = createObservedApp();
  app.get("/unexpected", () => {
    throw new Error("unexpected internal failure");
  });

  const response = await app.request("/unexpected");

  expect(response.status).toBe(500);
  expect(tracer.spans[0]?.status).toBe("error");
  const log = JSON.parse(lines[0] ?? "{}");
  expect(log).toMatchObject({
    level: "error",
    message: "http.request.error",
    errorCode: "INTERNAL_ERROR",
    statusCode: 500,
  });
  expect(log.error).toMatchObject({ name: "Error", message: "unexpected internal failure" });
});

test("classified database failures expose only stable sanitized HTTP errors", async () => {
  const { app, tracer, meter, lines } = createObservedApp();
  const raw = Object.assign(
    new Error("canceling statement due to statement timeout while executing SELECT secret_value"),
    {
      code: "57014",
      query: "SELECT secret_value FROM private_table",
      constraint: "private_constraint_name",
    },
  );
  app.get("/database-timeout", () => {
    throw normalizeDatabaseError(raw);
  });

  const response = await app.request("/database-timeout");
  const body = await response.json();

  expect(response.status).toBe(504);
  expect(body).toMatchObject({
    error: {
      code: "DATABASE_TIMEOUT",
      message: "Database operation timed out",
    },
  });
  expect(JSON.stringify(body)).not.toContain("secret_value");
  expect(JSON.stringify(body)).not.toContain("private_constraint_name");
  expect(tracer.spans[0]?.status).toBe("error");
  expect(meter.counters[0]?.attributes).toMatchObject({ status_code: 504 });

  const log = JSON.parse(lines[0] ?? "{}");
  expect(log).toMatchObject({
    level: "error",
    message: "http.request.error",
    errorCode: "DATABASE_TIMEOUT",
    statusCode: 504,
  });
});
