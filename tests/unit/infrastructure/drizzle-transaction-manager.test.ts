import { expect, mock, test } from "bun:test";
import type { Meter } from "../../../src/core/observability/meter";
import { NoopTracer } from "../../../src/core/observability/noop-tracer";
import type { TelemetryAttributes } from "../../../src/core/observability/tracer";
import type {
  Database,
  DatabaseSession,
} from "../../../src/infrastructure/database/database";
import { DatabaseObserver } from "../../../src/infrastructure/database/database-observer";
import { DrizzleTransactionManager } from "../../../src/infrastructure/database/drizzle-transaction-manager";

function codedError(code: string): Error {
  return Object.assign(new Error(`database failure ${code}`), { code });
}

function fakeDatabase() {
  const session = {} as DatabaseSession;
  const transaction = mock(
    async (operation: (transaction: DatabaseSession) => Promise<unknown>) =>
      operation(session),
  );
  return {
    database: { transaction } as unknown as Database,
    transaction,
  };
}

class RecordingMeter implements Meter {
  readonly increments: Array<{
    name: string;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];
  readonly records: Array<{
    name: string;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.increments.push({ name, value, ...(attributes ? { attributes } : {}) });
  }

  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.records.push({ name, value, ...(attributes ? { attributes } : {}) });
  }
}

test("does not retry retryable database failures unless the caller opts in", async () => {
  const { database, transaction } = fakeDatabase();
  const sleep = mock(async () => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    { maxAttempts: 3, sleep },
  );
  const failure = codedError("40001");
  const operation = mock(async () => {
    throw failure;
  });

  await expect(manager.run(operation)).rejects.toBe(failure);

  expect(operation).toHaveBeenCalledTimes(1);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("retries a replay-safe transaction with capped exponential full jitter", async () => {
  const { database, transaction } = fakeDatabase();
  const sleep = mock(async (_delayMs: number) => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      random: () => 0.5,
      sleep,
    },
  );
  let attempts = 0;

  const result = await manager.run(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw codedError("40001");
      }
      return "committed";
    },
    { retry: "safe" },
  );

  expect(result).toBe("committed");
  expect(transaction).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([5, 10]);
});

test("does not retry non-retryable failures even when replay is declared safe", async () => {
  const { database, transaction } = fakeDatabase();
  const sleep = mock(async () => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    { maxAttempts: 3, sleep },
  );
  const failure = codedError("23505");

  await expect(
    manager.run(
      async () => {
        throw failure;
      },
      { retry: "safe" },
    ),
  ).rejects.toBe(failure);

  expect(transaction).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("stops after the configured attempt budget is exhausted", async () => {
  const { database, transaction } = fakeDatabase();
  const sleep = mock(async () => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep },
  );

  await expect(
    manager.run(
      async () => {
        throw codedError("40P01");
      },
      { retry: "safe" },
    ),
  ).rejects.toMatchObject({ code: "40P01" });

  expect(transaction).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
});

test("records bounded retry and exhaustion telemetry after observer normalization", async () => {
  const { database } = fakeDatabase();
  const meter = new RecordingMeter();
  const observer = new DatabaseObserver({ tracer: new NoopTracer(), meter });
  const sleep = mock(async () => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    observer,
    {
      maxAttempts: 2,
      baseDelayMs: 20,
      maxDelayMs: 20,
      random: () => 0.5,
      sleep,
    },
  );

  await expect(
    manager.run(
      async () => {
        throw codedError("40001");
      },
      { retry: "safe" },
    ),
  ).rejects.toMatchObject({
    code: "DATABASE_BUSY",
    status: 503,
    cause: { code: "40001" },
  });

  expect(meter.increments).toEqual([
    {
      name: "db.transaction.retries",
      value: 1,
      attributes: {
        "db.system.name": "postgresql",
        "db.transaction.retry.reason": "serialization_failure",
      },
    },
    {
      name: "db.transaction.retry.exhausted",
      value: 1,
      attributes: {
        "db.system.name": "postgresql",
        "db.transaction.retry.reason": "serialization_failure",
      },
    },
  ]);
  expect(
    meter.records.filter((entry) => entry.name === "db.transaction.retry.delay"),
  ).toEqual([
    {
      name: "db.transaction.retry.delay",
      value: 0.01,
      attributes: {
        "db.system.name": "postgresql",
        "db.transaction.retry.reason": "serialization_failure",
      },
    },
  ]);
});

test("rejects invalid retry configuration at composition time", () => {
  const { database } = fakeDatabase();

  expect(
    () =>
      new DrizzleTransactionManager(database, () => ({}), undefined, {
        maxAttempts: 0,
      }),
  ).toThrow(RangeError);
  expect(
    () =>
      new DrizzleTransactionManager(database, () => ({}), undefined, {
        baseDelayMs: 100,
        maxDelayMs: 50,
      }),
  ).toThrow(RangeError);
});
