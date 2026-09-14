import { expect, test } from "bun:test";
import { NoopMeter } from "../../../../src/core/observability/noop-meter";
import { NoopTracer } from "../../../../src/core/observability/noop-tracer";

test("NoopTracer executes the operation without changing its result", async () => {
  const tracer = new NoopTracer();
  const result = await tracer.withSpan(
    "example.operation",
    {
      parent: {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
      },
      parentIsRemote: true,
    },
    async (span) => {
      span.setAttribute("example.attribute", "value");
      expect(span.traceContext()).toBeUndefined();
      return 42;
    },
  );

  expect(result).toBe(42);
});

test("NoopMeter accepts counters and histograms", () => {
  const meter = new NoopMeter();

  expect(() => {
    meter.increment("example.requests", 1, { route: "/users/:id" });
    meter.record("example.duration", 0.25, { route: "/users/:id" });
  }).not.toThrow();
});
