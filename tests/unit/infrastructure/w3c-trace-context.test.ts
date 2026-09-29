import { describe, expect, test } from "bun:test";
import {
  createRequestTrace,
  formatTraceParent,
  parseTraceParent,
  parseTraceState,
} from "../../../src/infrastructure/tracing/w3c-trace-context";

const validTraceParent =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("W3C trace context", () => {
  test("inherits a valid trace ID and creates a fresh local span ID", () => {
    const trace = createRequestTrace(validTraceParent, "vendor=value");

    expect(trace.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(trace.spanId).not.toBe("00f067aa0ba902b7");
    expect(trace.spanId).toMatch(/^(?!0{16}$)[0-9a-f]{16}$/);
    expect(trace.traceFlags).toBe("01");
    expect(trace.traceState).toBe("vendor=value");
    expect(formatTraceParent(trace)).toBe(
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${trace.spanId}-01`,
    );
  });

  test("rejects uppercase traceparent and does not trust its tracestate", () => {
    const incoming = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01";

    expect(parseTraceParent(incoming)).toBeNull();
    const trace = createRequestTrace(incoming, "untrusted=value");
    expect(trace.traceId).toMatch(/^(?!0{32}$)[0-9a-f]{32}$/);
    expect(trace.traceId).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(trace.traceState).toBeUndefined();
  });

  test("accepts valid simple and multi-tenant tracestate keys", () => {
    const traceState = "vendor=value,123tenant@system=value2";

    expect(parseTraceState(traceState)).toBe(traceState);
    expect(createRequestTrace(validTraceParent, traceState).traceState).toBe(traceState);
  });

  test("accepts the documented 512-character propagation boundary", () => {
    const key = `a${"b".repeat(254)}`;
    const value = "v".repeat(256);
    const traceState = `${key}=${value}`;

    expect(traceState).toHaveLength(512);
    expect(parseTraceState(traceState)).toBe(traceState);
  });

  test("accepts at most 32 tracestate list members", () => {
    const traceState = Array.from({ length: 32 }, (_, index) => `v${index}=x`).join(",");

    expect(parseTraceState(traceState)).toBe(traceState);
    expect(
      parseTraceState(`${traceState},overflow=x`),
    ).toBeUndefined();
  });

  test("drops malformed, duplicated, oversized, or unsupported tracestate", () => {
    for (const traceState of [
      "Vendor=value",
      "vendor=value,vendor=duplicate",
      "vendor=value=extra",
      "vendor=value,broken",
      `vendor=${"v".repeat(257)}`,
      `a=${"v".repeat(256)},b=${"w".repeat(252)}`,
    ]) {
      expect(parseTraceState(traceState)).toBeUndefined();
      const trace = createRequestTrace(validTraceParent, traceState);
      expect(trace.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(trace.traceState).toBeUndefined();
    }
  });

  test("accepts optional whitespace between list members without changing the field value", () => {
    const traceState = "vendor=value, 	other=second	";

    expect(parseTraceState(traceState)).toBe(traceState);
  });

  test("does not propagate an empty or whitespace-only tracestate", () => {
    expect(parseTraceState("")).toBeUndefined();
    expect(parseTraceState(" 	 ")).toBeUndefined();
  });
});
