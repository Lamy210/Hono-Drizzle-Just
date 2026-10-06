import {
  ROOT_CONTEXT,
  SpanKind as OpenTelemetrySpanKind,
  SpanStatusCode,
  context,
  createTraceState,
  trace,
  type Span as ApiSpan,
  type Tracer as ApiTracer,
} from "@opentelemetry/api";
import type { TraceContext } from "../../core/tracing/trace-context";
import type {
  Span,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TelemetryAttributeValue,
  Tracer,
} from "../../core/observability/tracer";

const spanKinds: Readonly<Record<SpanKind, OpenTelemetrySpanKind>> = {
  internal: OpenTelemetrySpanKind.INTERNAL,
  server: OpenTelemetrySpanKind.SERVER,
  client: OpenTelemetrySpanKind.CLIENT,
  producer: OpenTelemetrySpanKind.PRODUCER,
  consumer: OpenTelemetrySpanKind.CONSUMER,
};

const spanStatuses: Readonly<Record<SpanStatus, SpanStatusCode>> = {
  ok: SpanStatusCode.OK,
  error: SpanStatusCode.ERROR,
};

type RuntimeStartActiveSpan = (...args: unknown[]) => unknown;

function normalizeStartActiveSpan(tracer: unknown): RuntimeStartActiveSpan {
  if (typeof tracer !== "object" || tracer === null) {
    throw new TypeError("OpenTelemetry tracer must be an object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(tracer);
  } catch {
    throw new TypeError("OpenTelemetry tracer startActiveSpan could not be read");
  }
  if (isArray) {
    throw new TypeError("OpenTelemetry tracer must be an object");
  }

  let startActiveSpan: unknown;
  try {
    startActiveSpan = Reflect.get(tracer, "startActiveSpan");
  } catch {
    throw new TypeError("OpenTelemetry tracer startActiveSpan could not be read");
  }
  if (typeof startActiveSpan !== "function") {
    throw new TypeError("OpenTelemetry tracer startActiveSpan must be callable");
  }

  return (...args: unknown[]) => Reflect.apply(startActiveSpan, tracer, args);
}

function parentContext(options: SpanOptions) {
  if (!options.parent) {
    return context.active();
  }

  const traceState = options.parent.traceState
    ? createTraceState(options.parent.traceState)
    : undefined;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: options.parent.traceId,
    spanId: options.parent.spanId,
    traceFlags: Number.parseInt(options.parent.traceFlags, 16),
    isRemote: options.parentIsRemote ?? false,
    ...(traceState === undefined ? {} : { traceState }),
  });
}

function toTraceContext(span: ApiSpan): TraceContext {
  const value = span.spanContext();
  const traceState = value.traceState?.serialize();
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags.toString(16).padStart(2, "0"),
    ...(traceState ? { traceState } : {}),
  };
}

class OpenTelemetrySpan implements Span {
  constructor(private readonly span: ApiSpan) {}

  setAttribute(name: string, value: TelemetryAttributeValue): void {
    this.span.setAttribute(name, value);
  }

  setStatus(status: SpanStatus): void {
    this.span.setStatus({ code: spanStatuses[status] });
  }

  recordException(error: unknown): void {
    this.span.recordException(error instanceof Error ? error : String(error));
  }

  traceContext(): TraceContext {
    return toTraceContext(this.span);
  }
}

export class OpenTelemetryTracer implements Tracer {
  private readonly startActiveSpan: RuntimeStartActiveSpan;

  constructor(tracer: ApiTracer) {
    this.startActiveSpan = normalizeStartActiveSpan(tracer);
  }

  withSpan<T>(
    name: string,
    options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.startActiveSpan(
      name,
      {
        ...(options.kind === undefined ? {} : { kind: spanKinds[options.kind] }),
        ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
      },
      parentContext(options),
      async (apiSpan: ApiSpan) => {
        const span = new OpenTelemetrySpan(apiSpan);
        try {
          return await operation(span);
        } catch (error) {
          if (options.recordException !== false) {
            span.recordException(error);
          }
          span.setStatus("error");
          throw error;
        } finally {
          apiSpan.end();
        }
      },
    ) as Promise<T>;
  }
}
