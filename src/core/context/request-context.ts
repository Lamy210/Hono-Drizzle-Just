import type { TraceContext } from "../tracing/trace-context";

export interface RequestContext {
  readonly requestId: string;
  readonly trace: TraceContext;
  readonly startedAt: number;
}
