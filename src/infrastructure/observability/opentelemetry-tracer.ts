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
type RuntimeSpanMethod = (...args: unknown[]) => unknown;
type SpanMethodName =
  | "setAttribute"
  | "setStatus"
  | "recordException"
  | "spanContext"
  | "end";

interface NormalizedSpan {
  readonly setAttribute: ApiSpan["setAttribute"];
  readonly setStatus: ApiSpan["setStatus"];
  readonly recordException: ApiSpan["recordException"];
  readonly spanContext: ApiSpan["spanContext"];
  readonly end: ApiSpan["end"];
}

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

function requireSpanObject(span: unknown): object {
  const label = "OpenTelemetry span";
  if (typeof span !== "object" || span === null) {
    throw new TypeError(`${label} must be an object`);
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(span);
  } catch {
    throw new TypeError(`${label} could not be read`);
  }
  if (isArray) {
    throw new TypeError(`${label} must be an object`);
  }

  return span;
}

function normalizeSpanMethod(span: object, name: SpanMethodName): RuntimeSpanMethod {
  let method: unknown;
  try {
    method = Reflect.get(span, name);
  } catch {
    throw new TypeError(`OpenTelemetry span ${name} could not be read`);
  }
  if (typeof method !== "function") {
    throw new TypeError(`OpenTelemetry span ${name} must be callable`);
  }

  return (...args: unknown[]) => Reflect.apply(method, span, args);
}

function normalizeSpan(span: unknown): NormalizedSpan {
  const value = requireSpanObject(span);
  return {
    setAttribute: normalizeSpanMethod(value, "setAttribute") as ApiSpan["setAttribute"],
    setStatus: normalizeSpanMethod(value, "setStatus") as ApiSpan["setStatus"],
    recordException: normalizeSpanMethod(
      value,
      "recordException",
    ) as ApiSpan["recordException"],
    spanContext: normalizeSpanMethod(value, "spanContext") as ApiSpan["spanContext"],
    end: normalizeSpanMethod(value, "end") as ApiSpan["end"],
  };
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

function toTraceContext(value: ReturnType<ApiSpan["spanContext"]>): TraceContext {
  const traceState = value.traceState?.serialize();
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags.toString(16).padStart(2, "0"),
    ...(traceState ? { traceState } : {}),
  };
}

class OpenTelemetrySpan implements Span {
  private readonly setAttributeMethod: ApiSpan["setAttribute"];
  private readonly setStatusMethod: ApiSpan["setStatus"];
  private readonly recordExceptionMethod: ApiSpan["recordException"];
  private readonly spanContextMethod: ApiSpan["spanContext"];
  private readonly endMethod: ApiSpan["end"];

  constructor(span: ApiSpan) {
    const normalized = normalizeSpan(span);
    this.setAttributeMethod = normalized.setAttribute;
    this.setStatusMethod = normalized.setStatus;
    this.recordExceptionMethod = normalized.recordException;
    this.spanContextMethod = normalized.spanContext;
    this.endMethod = normalized.end;
  }

  setAttribute(name: string, value: TelemetryAttributeValue): void {
    try {
      this.setAttributeMethod(name, value);
    } catch {
      // Application results are authoritative over observability mutations.
    }
  }

  setStatus(status: SpanStatus): void {
    try {
      this.setStatusMethod({ code: spanStatuses[status] });
    } catch {
      // Application results are authoritative over observability mutations.
    }
  }

  recordException(error: unknown): void {
    try {
      this.recordExceptionMethod(error instanceof Error ? error : String(error));
    } catch {
      // Application errors are authoritative over observability mutations.
    }
  }

  traceContext(): TraceContext {
    return toTraceContext(this.spanContextMethod());
  }

  endBestEffort(): void {
    try {
      this.endMethod();
    } catch {
      // Application results and errors are authoritative over span finalization.
    }
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
          span.endBestEffort();
        }
      },
    ) as Promise<T>;
  }
}
