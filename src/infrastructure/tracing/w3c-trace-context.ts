import type { TraceContext } from "../../core/tracing/trace-context";

const TRACEPARENT_V00 = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createTraceId(): string {
  let value = randomHex(16);
  while (/^0{32}$/.test(value)) {
    value = randomHex(16);
  }
  return value;
}

export function createSpanId(): string {
  let value = randomHex(8);
  while (/^0{16}$/.test(value)) {
    value = randomHex(8);
  }
  return value;
}

export function parseTraceParent(value: string | null): TraceContext | null {
  if (!value) {
    return null;
  }
  const match = TRACEPARENT_V00.exec(value);
  if (!match) {
    return null;
  }
  const [, traceId, spanId, traceFlags] = match;
  if (!traceId || !spanId || !traceFlags) {
    return null;
  }
  return { traceId, spanId, traceFlags };
}

export function createRequestTrace(parentHeader: string | null, traceState?: string): TraceContext {
  const parent = parseTraceParent(parentHeader);
  if (!parent) {
    return { traceId: createTraceId(), spanId: createSpanId(), traceFlags: "01" };
  }

  const trace = {
    traceId: parent.traceId,
    spanId: createSpanId(),
    traceFlags: parent.traceFlags,
  };
  return traceState ? { ...trace, traceState } : trace;
}

export function formatTraceParent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}
