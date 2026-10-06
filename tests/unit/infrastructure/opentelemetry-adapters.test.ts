import { expect, mock, test } from "bun:test";
import {
  SpanKind as OpenTelemetrySpanKind,
  SpanStatusCode,
  createTraceState,
  trace,
  type Meter as ApiMeter,
  type Span as ApiSpan,
  type Tracer as ApiTracer,
} from "@opentelemetry/api";
import { OpenTelemetryMeter } from "../../../src/infrastructure/observability/opentelemetry-meter";
import { OpenTelemetryTracer } from "../../../src/infrastructure/observability/opentelemetry-tracer";

function makeSpan() {
  const setAttribute = mock(() => undefined);
  const setStatus = mock(() => undefined);
  const recordException = mock(() => undefined);
  const end = mock(() => undefined);
  const span = {
    setAttribute,
    setStatus,
    recordException,
    end,
    spanContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "a3ce929d0e0e4736",
      traceFlags: 1,
      traceState: createTraceState("vendor=value"),
    }),
  } as unknown as ApiSpan;
  return { span, setAttribute, setStatus, recordException, end };
}

function makeApiMeter(overrides: Record<string, unknown> = {}): ApiMeter {
  return {
    createCounter: () => ({ add: () => undefined }),
    createHistogram: () => ({ record: () => undefined }),
    createObservableUpDownCounter: () => ({
      addCallback: () => undefined,
      removeCallback: () => undefined,
    }),
    ...overrides,
  } as unknown as ApiMeter;
}

test("OpenTelemetryTracer maps span kind, remote parent, attributes, status, and trace context", async () => {
  const otel = makeSpan();
  let capturedName: string | undefined;
  let capturedKind: OpenTelemetrySpanKind | undefined;
  let capturedParent: ReturnType<typeof trace.getSpanContext>;

  const apiTracer = {
    startActiveSpan: ((name: string, options: { kind?: OpenTelemetrySpanKind }, parentContext: unknown, operation: (span: ApiSpan) => unknown) => {
      capturedName = name;
      capturedKind = options.kind;
      capturedParent = trace.getSpanContext(parentContext as Parameters<typeof trace.getSpanContext>[0]);
      return operation(otel.span);
    }) as ApiTracer["startActiveSpan"],
  } as ApiTracer;
  const tracer = new OpenTelemetryTracer(apiTracer);

  const result = await tracer.withSpan(
    "http.server.request",
    {
      kind: "server",
      attributes: { "http.request.method": "GET" },
      parent: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
        traceState: "vendor=value",
      },
      parentIsRemote: true,
    },
    async (span) => {
      span.setAttribute("http.response.status_code", 200);
      span.setStatus("ok");
      expect(span.traceContext()).toEqual({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "a3ce929d0e0e4736",
        traceFlags: "01",
        traceState: "vendor=value",
      });
      return 42;
    },
  );

  expect(result).toBe(42);
  expect(capturedName).toBe("http.server.request");
  expect(capturedKind).toBe(OpenTelemetrySpanKind.SERVER);
  expect(capturedParent).toMatchObject({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: 1,
    isRemote: true,
  });
  expect(otel.setAttribute).toHaveBeenCalledWith("http.response.status_code", 200);
  expect(otel.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
  expect(otel.end).toHaveBeenCalledTimes(1);
});

test("OpenTelemetryTracer records and rethrows operation failures", async () => {
  const otel = makeSpan();
  const apiTracer = {
    startActiveSpan: ((_name: string, _options: unknown, _parentContext: unknown, operation: (span: ApiSpan) => unknown) => operation(otel.span)) as ApiTracer["startActiveSpan"],
  } as ApiTracer;
  const tracer = new OpenTelemetryTracer(apiTracer);
  const failure = new Error("boom");

  await expect(
    tracer.withSpan("example.failure", {}, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(otel.recordException).toHaveBeenCalledWith(failure);
  expect(otel.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  expect(otel.end).toHaveBeenCalledTimes(1);
});

test("OpenTelemetryTracer can suppress exception events at sensitive boundaries", async () => {
  const otel = makeSpan();
  const apiTracer = {
    startActiveSpan: ((_name: string, _options: unknown, _parentContext: unknown, operation: (span: ApiSpan) => unknown) => operation(otel.span)) as ApiTracer["startActiveSpan"],
  } as ApiTracer;
  const tracer = new OpenTelemetryTracer(apiTracer);
  const failure = new Error("contains-sensitive-database-details");

  await expect(
    tracer.withSpan("sensitive.failure", { recordException: false }, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(otel.recordException).not.toHaveBeenCalled();
  expect(otel.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  expect(otel.end).toHaveBeenCalledTimes(1);
});

test("OpenTelemetryTracer rejects malformed tracer runtime wiring at construction", () => {
  expect(() => new OpenTelemetryTracer(null as unknown as ApiTracer)).toThrow(
    "OpenTelemetry tracer must be an object",
  );
  expect(() => new OpenTelemetryTracer(123 as unknown as ApiTracer)).toThrow(
    "OpenTelemetry tracer must be an object",
  );
  expect(() => new OpenTelemetryTracer([] as unknown as ApiTracer)).toThrow(
    "OpenTelemetry tracer must be an object",
  );
  expect(
    () =>
      new OpenTelemetryTracer({
        startActiveSpan: null,
      } as unknown as ApiTracer),
  ).toThrow("OpenTelemetry tracer startActiveSpan must be callable");
});

test("OpenTelemetryTracer normalizes a throwing startActiveSpan getter", () => {
  const apiTracer = Object.defineProperty({}, "startActiveSpan", {
    get() {
      throw new Error("provider failure");
    },
  }) as ApiTracer;

  expect(() => new OpenTelemetryTracer(apiTracer)).toThrow(
    "OpenTelemetry tracer startActiveSpan could not be read",
  );
});

test("OpenTelemetryTracer snapshots startActiveSpan once and preserves its receiver", async () => {
  const otel = makeSpan();
  let reads = 0;
  let receiverPreserved = false;
  let currentStartActiveSpan = function (
    this: unknown,
    _name: string,
    _options: unknown,
    _parentContext: unknown,
    operation: (span: ApiSpan) => unknown,
  ) {
    receiverPreserved = this === apiTracer;
    return operation(otel.span);
  } as ApiTracer["startActiveSpan"];
  const apiTracer = {
    get startActiveSpan(): ApiTracer["startActiveSpan"] {
      reads += 1;
      return currentStartActiveSpan;
    },
  } as ApiTracer;

  const tracer = new OpenTelemetryTracer(apiTracer);
  expect(reads).toBe(1);

  currentStartActiveSpan = (() => {
    throw new Error("replacement must not run");
  }) as ApiTracer["startActiveSpan"];

  const result = await tracer.withSpan("snapshot", {}, async () => 42);

  expect(result).toBe(42);
  expect(reads).toBe(1);
  expect(receiverPreserved).toBe(true);
  expect(otel.end).toHaveBeenCalledTimes(1);
});

test("OpenTelemetryMeter rejects malformed meter runtime wiring at construction", () => {
  expect(() => new OpenTelemetryMeter(null as unknown as ApiMeter)).toThrow(
    "OpenTelemetry meter must be an object",
  );
  expect(() => new OpenTelemetryMeter(123 as unknown as ApiMeter)).toThrow(
    "OpenTelemetry meter must be an object",
  );
  expect(() => new OpenTelemetryMeter([] as unknown as ApiMeter)).toThrow(
    "OpenTelemetry meter must be an object",
  );
  expect(() => new OpenTelemetryMeter(makeApiMeter({ createCounter: null }))).toThrow(
    "OpenTelemetry meter createCounter must be callable",
  );
  expect(() => new OpenTelemetryMeter(makeApiMeter({ createHistogram: null }))).toThrow(
    "OpenTelemetry meter createHistogram must be callable",
  );
  expect(
    () => new OpenTelemetryMeter(makeApiMeter({ createObservableUpDownCounter: null })),
  ).toThrow("OpenTelemetry meter createObservableUpDownCounter must be callable");
});

test("OpenTelemetryMeter normalizes throwing factory getters", () => {
  const counterMeter = Object.defineProperty(makeApiMeter(), "createCounter", {
    get() {
      throw new Error("provider failure");
    },
  });
  expect(() => new OpenTelemetryMeter(counterMeter)).toThrow(
    "OpenTelemetry meter createCounter could not be read",
  );

  const histogramMeter = Object.defineProperty(makeApiMeter(), "createHistogram", {
    get() {
      throw new Error("provider failure");
    },
  });
  expect(() => new OpenTelemetryMeter(histogramMeter)).toThrow(
    "OpenTelemetry meter createHistogram could not be read",
  );

  const observableMeter = Object.defineProperty(makeApiMeter(), "createObservableUpDownCounter", {
    get() {
      throw new Error("provider failure");
    },
  });
  expect(() => new OpenTelemetryMeter(observableMeter)).toThrow(
    "OpenTelemetry meter createObservableUpDownCounter could not be read",
  );
});

test("OpenTelemetryMeter snapshots factories once and preserves their receiver", () => {
  const counter = { add: mock(() => undefined) };
  const histogram = { record: mock(() => undefined) };
  const observable = {
    addCallback: mock(() => undefined),
    removeCallback: mock(() => undefined),
  };
  let counterReads = 0;
  let histogramReads = 0;
  let observableReads = 0;
  let counterReceiverPreserved = false;
  let histogramReceiverPreserved = false;
  let observableReceiverPreserved = false;
  let currentCreateCounter = function (this: unknown) {
    counterReceiverPreserved = this === apiMeter;
    return counter;
  } as unknown as ApiMeter["createCounter"];
  let currentCreateHistogram = function (this: unknown) {
    histogramReceiverPreserved = this === apiMeter;
    return histogram;
  } as unknown as ApiMeter["createHistogram"];
  let currentCreateObservableUpDownCounter = function (this: unknown) {
    observableReceiverPreserved = this === apiMeter;
    return observable;
  } as unknown as ApiMeter["createObservableUpDownCounter"];
  const apiMeter = {
    get createCounter(): ApiMeter["createCounter"] {
      counterReads += 1;
      return currentCreateCounter;
    },
    get createHistogram(): ApiMeter["createHistogram"] {
      histogramReads += 1;
      return currentCreateHistogram;
    },
    get createObservableUpDownCounter(): ApiMeter["createObservableUpDownCounter"] {
      observableReads += 1;
      return currentCreateObservableUpDownCounter;
    },
  } as ApiMeter;

  const meter = new OpenTelemetryMeter(apiMeter);
  expect(counterReads).toBe(1);
  expect(histogramReads).toBe(1);
  expect(observableReads).toBe(1);

  currentCreateCounter = (() => {
    throw new Error("replacement must not run");
  }) as unknown as ApiMeter["createCounter"];
  currentCreateHistogram = (() => {
    throw new Error("replacement must not run");
  }) as unknown as ApiMeter["createHistogram"];
  currentCreateObservableUpDownCounter = (() => {
    throw new Error("replacement must not run");
  }) as unknown as ApiMeter["createObservableUpDownCounter"];

  meter.increment("snapshot.counter");
  meter.record("snapshot.histogram", 1);
  const stop = meter.observeUpDownCounter("snapshot.observable", () => []);
  stop();

  expect(counterReads).toBe(1);
  expect(histogramReads).toBe(1);
  expect(observableReads).toBe(1);
  expect(counterReceiverPreserved).toBe(true);
  expect(histogramReceiverPreserved).toBe(true);
  expect(observableReceiverPreserved).toBe(true);
});

test("OpenTelemetryMeter caches instruments and forwards measurements", () => {
  const counter = { add: mock(() => undefined) };
  const histogram = { record: mock(() => undefined) };
  const createCounter = mock(() => counter);
  const createHistogram = mock(() => histogram);
  const meter = new OpenTelemetryMeter(makeApiMeter({ createCounter, createHistogram }));

  meter.increment("http.server.requests", 1, { method: "GET" });
  meter.increment("http.server.requests", 2, { method: "POST" });
  meter.record("http.server.duration", 0.25, { route: "/users/:id" });
  meter.record("http.server.duration", 0.5, { route: "/users/:id" });

  expect(createCounter).toHaveBeenCalledTimes(1);
  expect(counter.add).toHaveBeenCalledWith(1, { method: "GET" });
  expect(counter.add).toHaveBeenCalledWith(2, { method: "POST" });
  expect(createHistogram).toHaveBeenCalledTimes(1);
  expect(histogram.record).toHaveBeenCalledWith(0.25, { route: "/users/:id" });
  expect(histogram.record).toHaveBeenCalledWith(0.5, { route: "/users/:id" });
});

test("OpenTelemetryMeter forwards observable up/down measurements and unregisters callbacks", () => {
  type Result = {
    observe(value: number, attributes?: Record<string, string>): void;
  };
  let registered: ((result: Result) => void) | undefined;
  const addCallback = mock((callback: (result: Result) => void) => {
    registered = callback;
  });
  const removeCallback = mock(() => undefined);
  const createObservableUpDownCounter = mock(() => ({
    addCallback,
    removeCallback,
  }));
  const meter = new OpenTelemetryMeter(makeApiMeter({ createObservableUpDownCounter }));
  let current = 3;

  const stop = meter.observeUpDownCounter(
    "db.client.connection.pending_requests",
    () => [
      {
        value: current,
        attributes: { "db.client.connection.pool.name": "primary" },
      },
    ],
    { unit: "{request}", description: "Pending pool requests." },
  );

  expect(createObservableUpDownCounter).toHaveBeenCalledWith(
    "db.client.connection.pending_requests",
    { unit: "{request}", description: "Pending pool requests." },
  );

  const observe = mock(() => undefined);
  registered?.({ observe });
  expect(observe).toHaveBeenCalledWith(3, {
    "db.client.connection.pool.name": "primary",
  });

  current = 5;
  registered?.({ observe });
  expect(observe).toHaveBeenLastCalledWith(5, {
    "db.client.connection.pool.name": "primary",
  });

  stop();
  stop();
  expect(removeCallback).toHaveBeenCalledTimes(1);
});

test("OpenTelemetryMeter forwards semantic instrument options on first creation", () => {
  const counter = { add: mock(() => undefined) };
  const histogram = { record: mock(() => undefined) };
  const createCounter = mock(() => counter);
  const createHistogram = mock(() => histogram);
  const meter = new OpenTelemetryMeter(makeApiMeter({ createCounter, createHistogram }));

  meter.increment(
    "db.client.connection.timeouts",
    1,
    { "db.client.connection.pool.name": "primary" },
    { unit: "{timeout}", description: "Timeouts." },
  );
  meter.record(
    "db.client.connection.wait_time",
    0.05,
    { "db.client.connection.pool.name": "primary" },
    { unit: "s", description: "Wait time." },
  );

  expect(createCounter).toHaveBeenCalledWith(
    "db.client.connection.timeouts",
    { unit: "{timeout}", description: "Timeouts." },
  );
  expect(createHistogram).toHaveBeenCalledWith(
    "db.client.connection.wait_time",
    { unit: "s", description: "Wait time." },
  );
  expect(counter.add).toHaveBeenCalledWith(1, {
    "db.client.connection.pool.name": "primary",
  });
  expect(histogram.record).toHaveBeenCalledWith(0.05, {
    "db.client.connection.pool.name": "primary",
  });
});
