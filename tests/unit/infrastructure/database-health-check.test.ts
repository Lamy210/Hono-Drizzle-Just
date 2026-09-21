import { expect, mock, test } from "bun:test";
import type { Pool } from "pg";
import { DatabaseHealthCheck } from "../../../src/infrastructure/health/database-health-check";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function poolWithQuery(query: (text: string) => Promise<unknown>): Pick<Pool, "query"> {
  return { query } as unknown as Pick<Pool, "query">;
}

test("coalesces concurrent readiness checks onto one in-flight database query", async () => {
  const pending = deferred();
  const query = mock(async (text: string) => {
    expect(text).toBe("select 1");
    await pending.promise;
  });
  const healthCheck = new DatabaseHealthCheck(poolWithQuery(query), 1_000);

  const first = healthCheck.check();
  const second = healthCheck.check();
  await Promise.resolve();

  expect(query).toHaveBeenCalledTimes(1);

  pending.resolve();
  await Promise.all([first, second]);

  await healthCheck.check();
  expect(query).toHaveBeenCalledTimes(2);
});

test("timed-out callers reuse the pending database query until it settles", async () => {
  const pending = deferred();
  const query = mock(async () => {
    await pending.promise;
  });
  const healthCheck = new DatabaseHealthCheck(poolWithQuery(query), 10);

  const results = await Promise.allSettled([healthCheck.check(), healthCheck.check()]);

  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBeInstanceOf(Error);
      expect((result.reason as Error).message).toBe("database readiness check timed out");
    }
  }
  expect(query).toHaveBeenCalledTimes(1);

  pending.resolve();
  await Bun.sleep(0);

  await healthCheck.check();
  expect(query).toHaveBeenCalledTimes(2);
});
