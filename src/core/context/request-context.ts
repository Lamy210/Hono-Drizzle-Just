import type { Principal } from "../auth/principal";
import type { TraceContext } from "../tracing/trace-context";

export interface RequestContext {
  readonly requestId: string;
  readonly trace: TraceContext;
  readonly startedAt: number;
  readonly remoteAddress?: string;
  readonly principal?: Principal;
}
