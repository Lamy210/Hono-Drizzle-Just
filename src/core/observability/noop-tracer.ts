import type { Span, SpanOptions, Tracer } from "./tracer";

const noopSpan: Span = {
  setAttribute: () => undefined,
  setStatus: () => undefined,
  recordException: () => undefined,
  traceContext: () => undefined,
};

export class NoopTracer implements Tracer {
  async withSpan<T>(
    _name: string,
    _options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    return operation(noopSpan);
  }
}
