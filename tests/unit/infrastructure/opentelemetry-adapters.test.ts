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

test("OpenTelemetryMeter caches instruments and forwards measurements", () => {
  const counter = { add: mock(() => undefined) };
  const histogram = { record: mock(() => undefined) };
  const createCounter = mock(() => counter);
  const createHistogram = mock(() => histogram);
  const meter = new OpenTelemetryMeter({ createCounter, createHistogram } as unknown as ApiMeter);

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
