import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Meter } from "../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  TelemetryAttributeValue,
  Tracer,
} from "../../src/core/observability/tracer";
import type { TraceContext } from "../../src/core/tracing/trace-context";
import type { AppEnv } from "../../src/http/env";
import { createRequestContextMiddleware } from "../../src/http/middleware/request-context.middleware";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";

class RecordingSpan implements Span {
  readonly attributes = new Map<string, TelemetryAttributeValue>();
  status: "ok" | "error" | undefined;

  constructor(private readonly context: TraceContext) {}

  setAttribute(name: string, value: TelemetryAttributeValue): void {
    this.attributes.set(name, value);
  }

  setStatus(status: "ok" | "error"): void {
    this.status = status;
  }

  recordException(): void {}

  traceContext(): TraceContext {
    return this.context;
  }
}

class RecordingTracer implements Tracer {
  readonly calls: Array<{ name: string; options: SpanOptions; span: RecordingSpan }> = [];

  async withSpan<T>(
    name: string,
    options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = new RecordingSpan({
      traceId: options.parent?.traceId ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: options.parent?.traceFlags ?? "01",
      ...(options.parent?.traceState === undefined ? {} : { traceState: options.parent.traceState }),
    });
    this.calls.push({ name, options, span });
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

test("request context uses the telemetry span identity and records low-cardinality HTTP metrics", async () => {
  const tracer = new RecordingTracer();
  const meter = new RecordingMeter();
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, undefined, { tracer, meter }));
  app.get("/users/:id", (c) => c.json({ trace: c.get("requestContext").trace }));

  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    headers: {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    },
  });

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.trace).toEqual({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "bbbbbbbbbbbbbbbb",
    traceFlags: "01",
    traceState: "vendor=value",
  });
  expect(response.headers.get("traceparent")).toBe(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-bbbbbbbbbbbbbbbb-01",
  );

  expect(tracer.calls).toHaveLength(1);
  expect(tracer.calls[0]?.name).toBe("http.server.request");
  expect(tracer.calls[0]?.options).toMatchObject({
    kind: "server",
    parentIsRemote: true,
    parent: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
      traceState: "vendor=value",
    },
  });
  expect(tracer.calls[0]?.span.attributes.get("http.route")).toBe("/users/:id");
  expect(tracer.calls[0]?.span.attributes.get("http.response.status_code")).toBe(200);

  expect(meter.counters).toEqual([
    {
      name: "http.server.requests",
      value: 1,
      attributes: {
        method: "GET",
        route: "/users/:id",
        status_code: 200,
      },
    },
  ]);
  expect(meter.histograms).toHaveLength(1);
  expect(meter.histograms[0]?.name).toBe("http.server.duration");
  expect(meter.histograms[0]?.attributes).toEqual({
    method: "GET",
    route: "/users/:id",
    status_code: 200,
  });
  expect(meter.histograms[0]?.value).toBeGreaterThanOrEqual(0);
});
