import { expect, test } from "bun:test";
import { NoopMeter } from "../../../../src/core/observability/noop-meter";
import { NoopTracer } from "../../../../src/core/observability/noop-tracer";

test("NoopTracer executes the operation without changing its result", async () => {
  const tracer = new NoopTracer();
  const result = await tracer.withSpan("example.operation", {}, async (span) => {
    span.setAttribute("example.attribute", "value");
    return 42;
  });

  expect(result).toBe(42);
});

test("NoopMeter accepts counters and histograms", () => {
  const meter = new NoopMeter();

  expect(() => {
    meter.increment("example.requests", 1, { route: "/users/:id" });
    meter.record("example.duration", 0.25, { route: "/users/:id" });
  }).not.toThrow();
});
