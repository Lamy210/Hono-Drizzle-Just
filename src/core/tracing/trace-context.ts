export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly traceState?: string;
}
