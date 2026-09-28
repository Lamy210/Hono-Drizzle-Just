import { expect, test } from "bun:test";
import { ReadinessChecker } from "../../../../src/core/health/readiness-checker";
import { ReadinessGate } from "../../../../src/core/health/readiness-gate";

test("readiness gate starts ready and becomes permanently not ready when draining begins", async () => {
  const gate = new ReadinessGate();
  const checker = new ReadinessChecker([gate]);

  expect(await checker.check()).toMatchObject({
    status: "ready",
    checks: { lifecycle: { status: "up" } },
  });

  gate.markNotReady();
  gate.markNotReady();

  expect(await checker.check()).toMatchObject({
    status: "not_ready",
    checks: { lifecycle: { status: "down" } },
  });
});
