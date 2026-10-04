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

test("starts a fresh database query after a failed probe settles", async () => {
  let attempts = 0;
  const query = mock(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("database unavailable");
    }
  });
  const healthCheck = new DatabaseHealthCheck(poolWithQuery(query), 1_000);

  await expect(healthCheck.check()).rejects.toThrow("database unavailable");
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

test("rejects invalid database health-check timeouts at construction", () => {
  const query = mock(async () => {});
  const invalidTimeouts: readonly unknown[] = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    "1000",
  ];

  for (const timeoutMs of invalidTimeouts) {
    expect(
      () =>
        new DatabaseHealthCheck(
          poolWithQuery(query),
          timeoutMs as number,
        ),
    ).toThrow("Database health check timeout must be a positive safe integer");
  }

  expect(query).not.toHaveBeenCalled();
});

test("rejects malformed database pool query wiring at construction", () => {
  expect(
    () =>
      new DatabaseHealthCheck(
        null as unknown as Pick<Pool, "query">,
        1_000,
      ),
  ).toThrow("Database health check pool must be an object");

  expect(
    () =>
      new DatabaseHealthCheck(
        { query: null } as unknown as Pick<Pool, "query">,
        1_000,
      ),
  ).toThrow("Database health check pool query must be callable");
});

test("normalizes throwing database pool query getters", () => {
  const pool = Object.defineProperty({}, "query", {
    get() {
      throw new Error("provider-private query getter failure");
    },
  });

  expect(
    () =>
      new DatabaseHealthCheck(
        pool as Pick<Pool, "query">,
        1_000,
      ),
  ).toThrow("Database health check pool query could not be read");
});

test("resolves database pool query once and preserves its receiver", async () => {
  let queryReads = 0;
  let queryCalls = 0;
  const pool = {
    marker: "expected-pool-receiver",
    get query() {
      queryReads += 1;
      return async function (this: { marker: string }, text: string): Promise<void> {
        queryCalls += 1;
        expect(this.marker).toBe("expected-pool-receiver");
        expect(text).toBe("select 1");
      };
    },
  };

  const healthCheck = new DatabaseHealthCheck(
    pool as unknown as Pick<Pool, "query">,
    1_000,
  );

  expect(queryReads).toBe(1);

  await healthCheck.check();
  await healthCheck.check();

  expect(queryReads).toBe(1);
  expect(queryCalls).toBe(2);
});
