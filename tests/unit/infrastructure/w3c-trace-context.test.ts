import { describe, expect, test } from "bun:test";
import {
  createRequestTrace,
  formatTraceParent,
  parseTraceParent,
} from "../../../src/infrastructure/tracing/w3c-trace-context";

describe("W3C trace context", () => {
  test("inherits a valid trace ID and creates a fresh local span ID", () => {
    const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const trace = createRequestTrace(incoming, "vendor=value");

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
});
