export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type SpanStatus = "ok" | "error";

export interface Span {
  setAttribute(name: string, value: TelemetryAttributeValue): void;
  setStatus(status: SpanStatus): void;
  recordException(error: unknown): void;
}

export interface SpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: TelemetryAttributes;
}

export interface Tracer {
  withSpan<T>(
    name: string,
    options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T>;
}
