import { expect, mock, test } from "bun:test";
import type {
  Database,
  DatabaseSession,
} from "../../../src/infrastructure/database/database";
import type { DatabaseObserver } from "../../../src/infrastructure/database/database-observer";
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

test("constructor rejects non-callable database transaction wiring", () => {
  expect(
    () =>
      new DrizzleTransactionManager(
        { transaction: null } as unknown as Database,
        () => ({}),
      ),
  ).toThrow("DrizzleTransactionManager database transaction must be callable");
});

test("constructor rejects non-callable unit-of-work factory wiring", () => {
  const { database } = fakeDatabase();

  expect(
    () =>
      new DrizzleTransactionManager(
        database,
        null as unknown as (session: DatabaseSession) => object,
      ),
  ).toThrow("DrizzleTransactionManager unit-of-work factory must be callable");
});

test("constructor rejects malformed observer wiring", () => {
  const { database } = fakeDatabase();
  const observer = {
    transaction: async (execute: () => Promise<unknown>) => execute(),
    transactionRetryScheduled: null,
    transactionRetryExhausted() {},
  } as unknown as DatabaseObserver;

  expect(
    () => new DrizzleTransactionManager(database, () => ({}), observer),
  ).toThrow(
    "DrizzleTransactionManager observer transactionRetryScheduled must be callable",
  );
});

test("constructor snapshots transaction wiring exactly once and preserves receivers", async () => {
  const session = {} as DatabaseSession;
  const reads = {
    databaseTransaction: 0,
    observerTransaction: 0,
    observerRetryScheduled: 0,
    observerRetryExhausted: 0,
  };
  const receivers = {
    databaseTransaction: 0,
    observerTransaction: 0,
    observerRetryScheduled: 0,
    observerRetryExhausted: 0,
  };

  const databaseTarget = {
    get transaction() {
      reads.databaseTransaction += 1;
      return async function (
        this: unknown,
        operation: (transaction: DatabaseSession) => Promise<unknown>,
      ) {
        if (this === databaseTarget) {
          receivers.databaseTransaction += 1;
        }
        return operation(session);
      };
    },
  };
  const observerTarget = {
    get transaction() {
      reads.observerTransaction += 1;
      return async function (this: unknown, execute: () => Promise<unknown>) {
        if (this === observerTarget) {
          receivers.observerTransaction += 1;
        }
        return execute();
      };
    },
    get transactionRetryScheduled() {
      reads.observerRetryScheduled += 1;
      return function (this: unknown) {
        if (this === observerTarget) {
          receivers.observerRetryScheduled += 1;
        }
      };
    },
    get transactionRetryExhausted() {
      reads.observerRetryExhausted += 1;
      return function (this: unknown) {
        if (this === observerTarget) {
          receivers.observerRetryExhausted += 1;
        }
      };
    },
  };
  const sleep = mock(async (_delayMs: number) => undefined);
  const manager = new DrizzleTransactionManager(
    databaseTarget as unknown as Database,
    () => ({}),
    observerTarget as unknown as DatabaseObserver,
    {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      random: () => 0,
      sleep,
    },
  );

  expect(reads).toEqual({
    databaseTransaction: 1,
    observerTransaction: 1,
    observerRetryScheduled: 1,
    observerRetryExhausted: 1,
  });

  let attempts = 0;
  const result = await manager.run(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw codedError("40001");
      }
      return "committed";
    },
    { retry: "safe" },
  );

  expect(result).toBe("committed");
  expect(reads).toEqual({
    databaseTransaction: 1,
    observerTransaction: 1,
    observerRetryScheduled: 1,
    observerRetryExhausted: 1,
  });
  expect(receivers).toEqual({
    databaseTransaction: 2,
    observerTransaction: 2,
    observerRetryScheduled: 1,
    observerRetryExhausted: 0,
  });
  expect(sleep).toHaveBeenCalledTimes(1);
});
