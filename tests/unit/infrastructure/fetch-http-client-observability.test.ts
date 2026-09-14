import { expect, mock, test } from "bun:test";
import type { Meter } from "../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  TelemetryAttributeValue,
  Tracer,
} from "../../../src/core/observability/tracer";
import type { TraceContext } from "../../../src/core/tracing/trace-context";
import { FetchHttpClient } from "../../../src/infrastructure/http/fetch-http-client";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

class ClientSpan implements Span {
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

class ClientTracer implements Tracer {
  readonly calls: Array<{ name: string; options: SpanOptions; span: ClientSpan }> = [];

  async withSpan<T>(name: string, options: SpanOptions, operation: (span: Span) => Promise<T>): Promise<T> {
    const span = new ClientSpan({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "cccccccccccccccc",
      traceFlags: "01",
      traceState: "vendor=value",
    });
    this.calls.push({ name, options, span });
    return operation(span);
  }
}

class ClientMeter implements Meter {
  readonly counters: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];
  readonly histograms: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.counters.push({ name, value, ...(attributes === undefined ? {} : { attributes }) });
  }

  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.histograms.push({ name, value, ...(attributes === undefined ? {} : { attributes }) });
  }
}

test("outbound HTTP uses one client span across retries and propagates its trace context", async () => {
  const tracer = new ClientTracer();
  const meter = new ClientMeter();
  const seenTraceParents: string[] = [];
  let attempt = 0;
  const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    attempt += 1;
    seenTraceParents.push(new Headers(init?.headers).get("traceparent") ?? "");
    if (attempt === 1) {
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({ ok: true });
  });
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    tracer,
    meter,
    retryPolicy: {
      nextDelay: (_request, currentAttempt) => (currentAttempt === 1 ? 0 : null),
    },
  });

  const response = await client.request(
    {
      method: "GET",
      path: "/users/550e8400-e29b-41d4-a716-446655440000",
      context: {
        requestId: "550e8400-e29b-41d4-a716-446655440001",
        trace: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "bbbbbbbbbbbbbbbb",
          traceFlags: "01",
          traceState: "vendor=value",
        },
        startedAt: 0,
      },
    },
    { parse: (value) => value as { ok: boolean } },
  );

  expect(response.data).toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(seenTraceParents).toEqual([
    "00-4bf92f3577b34da6a3ce929d0e0e4736-cccccccccccccccc-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-cccccccccccccccc-01",
  ]);
  expect(tracer.calls).toHaveLength(1);
  expect(tracer.calls[0]?.name).toBe("http.client.request");
  expect(tracer.calls[0]?.options).toMatchObject({
    kind: "client",
    attributes: {
      "http.request.method": "GET",
      "server.address": "api.example.test",
    },
  });
  expect(tracer.calls[0]?.span.attributes.get("http.response.status_code")).toBe(200);
  expect(meter.counters).toEqual([
    {
      name: "http.client.requests",
      value: 1,
      attributes: {
        method: "GET",
        upstream: "api.example.test",
        outcome: "success",
        status_code: 200,
      },
    },
  ]);
  expect(meter.histograms[0]?.name).toBe("http.client.duration");
  expect(meter.histograms[0]?.attributes).toEqual({
    method: "GET",
    upstream: "api.example.test",
    outcome: "success",
    status_code: 200,
  });
  expect(meter.histograms[0]?.value).toBeGreaterThanOrEqual(0);
});
