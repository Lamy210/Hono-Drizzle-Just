import { describe, expect, test } from "bun:test";
import type { HealthCheck } from "../../../../src/core/health/health-check";
import { ReadinessChecker } from "../../../../src/core/health/readiness-checker";

function check(name: string, implementation: () => Promise<void>): HealthCheck {
  return { name, check: implementation };
}

describe("ReadinessChecker", () => {
  test("is ready when every critical check succeeds", async () => {
    const readiness = new ReadinessChecker([
      check("database", async () => undefined),
      check("cache", async () => undefined),
    ]);

    const result = await readiness.check();

    expect(result.status).toBe("ready");
    expect(result.checks.database?.status).toBe("up");
    expect(result.checks.cache?.status).toBe("up");
  });

  test("is not ready and contains the failed check when a dependency throws", async () => {
    const readiness = new ReadinessChecker([
      check("database", async () => {
        throw new Error("connection refused");
      }),
      check("cache", async () => undefined),
    ]);

    const result = await readiness.check();

    expect(result.status).toBe("not_ready");
    expect(result.checks.database?.status).toBe("down");
    expect(result.checks.cache?.status).toBe("up");
    expect(JSON.stringify(result)).not.toContain("connection refused");
  });
});
