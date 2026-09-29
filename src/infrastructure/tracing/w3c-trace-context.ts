import type { TraceContext } from "../../core/tracing/trace-context";

const TRACEPARENT_V00 = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_SIMPLE_KEY = /^[a-z][a-z0-9_*/-]{0,255}$/;
const TRACESTATE_MULTI_TENANT_KEY =
  /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/;
const TRACESTATE_VALUE =
  /^[\x20-\x2B\x2D-\x3C\x3E-\x7E]{0,255}[\x21-\x2B\x2D-\x3C\x3E-\x7E]$/;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_TRACESTATE_MEMBERS = 32;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trimOptionalWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

function isTraceStateKey(value: string): boolean {
  return TRACESTATE_SIMPLE_KEY.test(value) || TRACESTATE_MULTI_TENANT_KEY.test(value);
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

export function parseTraceState(value: string | null | undefined): string | undefined {
  if (!value || value.length > MAX_TRACESTATE_LENGTH) {
    return undefined;
  }

  const members = value.split(",");
  if (members.length > MAX_TRACESTATE_MEMBERS) {
    return undefined;
  }

  const keys = new Set<string>();
  let hasMember = false;

  for (const rawMember of members) {
    const member = trimOptionalWhitespace(rawMember);
    if (member === "") {
      continue;
    }

    const separator = member.indexOf("=");
    if (separator <= 0 || member.indexOf("=", separator + 1) !== -1) {
      return undefined;
    }

    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (!isTraceStateKey(key) || !TRACESTATE_VALUE.test(memberValue) || keys.has(key)) {
      return undefined;
    }

    keys.add(key);
    hasMember = true;
  }

  return hasMember ? value : undefined;
}

export function createRequestTrace(
  parentHeader: string | null,
  traceStateHeader?: string,
): TraceContext {
  const parent = parseTraceParent(parentHeader);
  if (!parent) {
    return { traceId: createTraceId(), spanId: createSpanId(), traceFlags: "01" };
  }

  const traceState = parseTraceState(traceStateHeader);
  const trace = {
    traceId: parent.traceId,
    spanId: createSpanId(),
    traceFlags: parent.traceFlags,
  };
  return traceState === undefined ? trace : { ...trace, traceState };
}

export function formatTraceParent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}
