import { expect, mock, test } from "bun:test";
import type { HttpRequest } from "../../../src/core/http/http-client";
import type { Meter } from "../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  TelemetryAttributeValue,
  Tracer,
} from "../../../src/core/observability/tracer";
import type { TraceContext } from "../../../src/core/tracing/trace-context";
import {
  FetchHttpClient,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
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

class ThrowingMeter implements Meter {
  increment(): void {
    throw new Error("counter backend unavailable");
  }

  record(): void {
    throw new Error("histogram backend unavailable");
  }
}

test("span attribute mutation failures do not discard successful upstream responses", async () => {
  const traceContext = () => ({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "cccccccccccccccc",
    traceFlags: "01",
  });
  const throwingAttributeGetter = Object.defineProperties(
    { traceContext },
    {
      setAttribute: {
        get() {
          throw new Error("attribute getter unavailable");
        },
      },
    },
  );
  const spans: unknown[] = [
    { traceContext },
    { traceContext, setAttribute: "not-callable" },
    throwingAttributeGetter,
    {
      traceContext,
      setAttribute() {
        throw new Error("attribute exporter unavailable");
      },
    },
  ];

  for (const runtimeSpan of spans) {
    let fetchCalls = 0;
    const tracer: Tracer = {
      async withSpan<T>(
        _name: string,
        _options: SpanOptions,
        operation: (span: Span) => Promise<T>,
      ): Promise<T> {
        return operation(runtimeSpan as Span);
      },
    };
    const client = new FetchHttpClient({
      baseUrl: "https://api.example.test",
      logger: new JsonConsoleLogger({}, () => undefined),
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      },
      tracer,
    });

    const response = await client.request(
      { method: "GET", path: "/resource" },
      { parse: (value) => value as { ok: boolean } },
    );

    expect(response.data).toEqual({ ok: true });
    expect(fetchCalls).toBe(1);
  }
});

test("span mutation failures do not replace authoritative upstream failures", async () => {
  const span = {
    traceContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "cccccccccccccccc",
      traceFlags: "01",
    }),
    setAttribute() {
      throw new Error("attribute exporter unavailable");
    },
    setStatus() {
      throw new Error("status exporter unavailable");
    },
  } as unknown as Span;
  const tracer: Tracer = {
    async withSpan<T>(
      _name: string,
      _options: SpanOptions,
      operation: (span: Span) => Promise<T>,
    ): Promise<T> {
      return operation(span);
    },
  };
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    retryPolicy: { nextDelay: () => null },
    tracer,
  });

  await expect(
    client.request(
      { method: "GET", path: "/resource" },
      { parse: (value) => value },
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    status: 502,
    diagnostics: {
      host: "api.example.test",
      status: 503,
    },
  });
});

test("invalid tracer span trace contexts fail locally before network access", async () => {
  const throwingTraceContext = Object.defineProperty({}, "traceContext", {
    get() {
      throw new Error("private span traceContext getter failure");
    },
  });
  const invalidSpans: unknown[] = [
    null,
    {},
    { traceContext: "not-callable" },
    throwingTraceContext,
    { traceContext: () => null },
    {
      traceContext: () => ({
        traceId: "not-a-trace-id",
        spanId: "cccccccccccccccc",
        traceFlags: "01",
      }),
    },
    {
      traceContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "cccccccccccccccc",
        traceFlags: "01",
        traceState: 42,
      }),
    },
  ];

  for (const span of invalidSpans) {
    let fetchCalls = 0;
    const tracer: Tracer = {
      async withSpan<T>(
        _name: string,
        _options: SpanOptions,
        operation: (span: Span) => Promise<T>,
      ): Promise<T> {
        return operation(span as Span);
      },
    };
    const client = new FetchHttpClient({
      baseUrl: "https://api.example.test",
      logger: new JsonConsoleLogger({}, () => undefined),
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      },
      tracer,
    });

    await expect(
      client.request(
        { method: "GET", path: "/resource" },
        { parse: (value) => value },
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      diagnostics: { host: "api.example.test" },
    });

    expect(fetchCalls).toBe(0);
  }
});

test("tracer span trace context is normalized before outbound propagation", async () => {
  const reads = {
    traceId: 0,
    spanId: 0,
    traceFlags: 0,
    traceState: 0,
  };
  const runtimeTrace = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(runtimeTrace, {
    traceId: {
      get() {
        reads.traceId += 1;
        if (reads.traceId > 1) throw new Error("traceId read twice");
        return "4bf92f3577b34da6a3ce929d0e0e4736";
      },
    },
    spanId: {
      get() {
        reads.spanId += 1;
        if (reads.spanId > 1) throw new Error("spanId read twice");
        return "cccccccccccccccc";
      },
    },
    traceFlags: {
      get() {
        reads.traceFlags += 1;
        if (reads.traceFlags > 1) throw new Error("traceFlags read twice");
        return "01";
      },
    },
    traceState: {
      get() {
        reads.traceState += 1;
        if (reads.traceState > 1) throw new Error("traceState read twice");
        return "vendor=value";
      },
    },
  });

  const span: Span = {
    setAttribute: () => undefined,
    setStatus: () => undefined,
    recordException: () => undefined,
    traceContext: () => runtimeTrace as unknown as TraceContext,
  };
  const tracer: Tracer = {
    async withSpan<T>(
      _name: string,
      _options: SpanOptions,
      operation: (span: Span) => Promise<T>,
    ): Promise<T> {
      return operation(span);
    },
  };
  let traceparent = "";
  let tracestate = "";
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async (_input, init) => {
      const headers = new Headers(init?.headers);
      traceparent = headers.get("traceparent") ?? "";
      tracestate = headers.get("tracestate") ?? "";
      return Response.json({ ok: true });
    },
    tracer,
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    { parse: (value) => value as { ok: boolean } },
  );

  expect(response.data).toEqual({ ok: true });
  expect(traceparent).toBe(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-cccccccccccccccc-01",
  );
  expect(tracestate).toBe("vendor=value");
  expect(reads).toEqual({
    traceId: 1,
    spanId: 1,
    traceFlags: 1,
    traceState: 1,
  });
});

test("invalid runtime tracer shapes fail locally before clocks or network access", async () => {
  const throwingTracer = Object.defineProperty({}, "withSpan", {
    get() {
      throw new Error("private tracer getter failure");
    },
  });
  const invalidTracers: unknown[] = [
    null,
    {},
    { withSpan: "not-callable" },
    throwingTracer,
  ];

  for (const invalidTracer of invalidTracers) {
    let fetchCalls = 0;
    let nowCalls = 0;
    const client = new FetchHttpClient({
      baseUrl: "https://api.example.test",
      logger: new JsonConsoleLogger({}, () => undefined),
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      },
      now: () => {
        nowCalls += 1;
        return 0;
      },
      tracer: invalidTracer as Tracer,
    });

    await expect(
      client.request(
        { method: "GET", path: "/resource" },
        { parse: (value) => value },
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP tracer was invalid",
      details: undefined,
      diagnostics: { host: "api.example.test" },
    });

    expect(nowCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  }
});

test("tracer withSpan is resolved once and keeps its receiver", async () => {
  const tracer = new ClientTracer();
  const inheritedWithSpan = ClientTracer.prototype.withSpan;
  let getterReads = 0;
  Object.defineProperty(tracer, "withSpan", {
    configurable: true,
    get() {
      getterReads += 1;
      if (getterReads > 1) {
        throw new Error("withSpan getter must not be evaluated twice");
      }
      return inheritedWithSpan;
    },
  });

  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => Response.json({ ok: true }),
    tracer,
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    { parse: (value) => value as { ok: boolean } },
  );

  expect(response.data).toEqual({ ok: true });
  expect(getterReads).toBe(1);
  expect(tracer.calls).toHaveLength(1);
});

test("invalid runtime methods never become outbound telemetry dimensions", async () => {
  const tracer = new ClientTracer();
  const meter = new ClientMeter();
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
    tracer,
    meter,
  });

  const request = {
    method: "x-user-controlled-method",
    path: "/resource",
  } as unknown as HttpRequest;

  await expect(client.request(request, { parse: (value) => value })).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    message: "Outbound HTTP method was invalid",
  });

  expect(fetchCalls).toBe(0);
  expect(tracer.calls).toEqual([]);
  expect(meter.counters).toEqual([]);
  expect(meter.histograms).toEqual([]);
});

test("invalid runtime retry controls never become outbound telemetry dimensions", async () => {
  const tracer = new ClientTracer();
  const meter = new ClientMeter();
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
    tracer,
    meter,
  });

  const request = {
    method: "GET",
    path: "/resource",
    retry: "attacker-controlled-mode",
  } as unknown as HttpRequest;

  await expect(client.request(request, { parse: (value) => value })).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    message: "Outbound HTTP retry mode was invalid",
  });

  expect(fetchCalls).toBe(0);
  expect(tracer.calls).toEqual([]);
  expect(meter.counters).toEqual([]);
  expect(meter.histograms).toEqual([]);
});

test("invalid request tracestate is removed before tracer parentage", async () => {
  const tracer = new ClientTracer();
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => Response.json({ ok: true }),
    tracer,
  });

  const response = await client.request(
    {
      method: "GET",
      path: "/resource",
      context: {
        requestId: "request-123",
        trace: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: "01",
          traceState: "vendor=value,vendor=duplicate",
        },
        startedAt: 0,
      },
    },
    { parse: (value) => value as { ok: boolean } },
  );

  expect(response.data).toEqual({ ok: true });
  expect(tracer.calls).toHaveLength(1);
  expect(tracer.calls[0]?.options.parent).toEqual({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  });
  expect(tracer.calls[0]?.options.parentIsRemote).toBe(false);
});

test("invalid runtime request context never reaches tracer, metrics, or fetch", async () => {
  const tracer = new ClientTracer();
  const meter = new ClientMeter();
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
    tracer,
    meter,
  });

  const request = {
    method: "GET",
    path: "/resource",
    context: {
      requestId: "request-123",
      trace: {
        traceId: "00000000000000000000000000000000",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
      },
      startedAt: 0,
    },
  } as unknown as HttpRequest;

  await expect(client.request(request, { parse: (value) => value })).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    message: "Outbound HTTP request context was invalid",
  });

  expect(fetchCalls).toBe(0);
  expect(tracer.calls).toEqual([]);
  expect(meter.counters).toEqual([]);
  expect(meter.histograms).toEqual([]);
});

test("invalid fetch hook responses are recorded as local client errors without status", async () => {
  const tracer = new ClientTracer();
  const meter = new ClientMeter();
  let attempts = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: (async () => {
      attempts += 1;
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as FetchLike,
    tracer,
    meter,
  });

  await expect(
    client.request(
      { method: "GET", path: "/resource" },
      { parse: (value) => value },
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    message: "Outbound HTTP fetch implementation returned an invalid response",
  });

  expect(attempts).toBe(1);
  expect(tracer.calls).toHaveLength(1);
  expect(tracer.calls[0]?.span.status).toBe("error");
  expect(tracer.calls[0]?.span.attributes.has("http.response.status_code")).toBe(false);
  expect(meter.counters).toContainEqual({
    name: "http.client.requests",
    value: 1,
    attributes: {
      method: "GET",
      upstream: "api.example.test",
      outcome: "error",
    },
  });
});

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


test("final upstream status remains available to client metrics through internal diagnostics", async () => {
  const tracer = new ClientTracer();
  const meter = new ClientMeter();
  const client = new FetchHttpClient({
    baseUrl: "https://internal.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: mock(async () => new Response("unavailable", { status: 503 })),
    tracer,
    meter,
    retryPolicy: { nextDelay: () => null },
  });

  await expect(
    client.request(
      { method: "GET", path: "/private-resource" },
      { parse: (value) => value },
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    message: "Upstream request failed",
    details: undefined,
    diagnostics: { status: 503, host: "internal.example.test" },
  });

  expect(meter.counters).toContainEqual({
    name: "http.client.requests",
    value: 1,
    attributes: {
      method: "GET",
      upstream: "internal.example.test",
      outcome: "error",
      status_code: 503,
    },
  });
});

test("post-response clock failures do not discard successful upstream responses", async () => {
  let nowCalls = 0;
  const meter = new ClientMeter();
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => Response.json({ ok: true }),
    now: () => {
      nowCalls += 1;
      if (nowCalls <= 2) {
        return nowCalls - 1;
      }
      throw new Error("clock unavailable after authoritative result");
    },
    meter,
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    { parse: (value) => value as { ok: boolean } },
  );

  expect(response.data).toEqual({ ok: true });
  expect(nowCalls).toBe(4);
  expect(meter.counters).toContainEqual({
    name: "http.client.requests",
    value: 1,
    attributes: {
      method: "GET",
      upstream: "api.example.test",
      outcome: "success",
      status_code: 200,
    },
  });
  expect(meter.histograms).toEqual([]);
});

test("post-error clock failures do not replace authoritative upstream failures", async () => {
  let nowCalls = 0;
  const meter = new ClientMeter();
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    retryPolicy: { nextDelay: () => null },
    now: () => {
      nowCalls += 1;
      if (nowCalls <= 2) {
        return nowCalls - 1;
      }
      throw new Error("clock unavailable during error telemetry");
    },
    meter,
  });

  await expect(
    client.request(
      { method: "GET", path: "/resource" },
      { parse: (value) => value },
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    status: 502,
    diagnostics: {
      host: "api.example.test",
      status: 503,
    },
  });

  expect(nowCalls).toBe(3);
  expect(meter.counters).toContainEqual({
    name: "http.client.requests",
    value: 1,
    attributes: {
      method: "GET",
      upstream: "api.example.test",
      outcome: "error",
      status_code: 503,
    },
  });
  expect(meter.histograms).toEqual([]);
});

test("meter failures do not discard successful upstream responses", async () => {
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
    meter: new ThrowingMeter(),
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    { parse: (value) => value as { ok: boolean } },
  );

  expect(response.data).toEqual({ ok: true });
  expect(fetchCalls).toBe(1);
});

test("meter failures do not replace authoritative upstream failures", async () => {
  const client = new FetchHttpClient({
    baseUrl: "https://api.example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
    retryPolicy: { nextDelay: () => null },
    meter: new ThrowingMeter(),
  });

  await expect(
    client.request(
      { method: "GET", path: "/resource" },
      { parse: (value) => value },
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    status: 502,
    diagnostics: {
      host: "api.example.test",
      status: 503,
    },
  });
});

