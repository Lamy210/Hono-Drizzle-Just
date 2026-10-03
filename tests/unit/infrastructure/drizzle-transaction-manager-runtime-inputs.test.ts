import { expect, mock, test } from "bun:test";
import type { TransactionRunOptions } from "../../../src/core/transaction/transaction-manager";
import type {
  Database,
  DatabaseSession,
} from "../../../src/infrastructure/database/database";
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

test("run rejects invalid runtime option containers before database work", async () => {
  for (const options of [null, "options", 1, true, [], () => undefined]) {
    const { database, transaction } = fakeDatabase();
    const manager = new DrizzleTransactionManager(database, () => ({}));

    await expect(
      manager.run(
        async () => "committed",
        options as unknown as TransactionRunOptions,
      ),
    ).rejects.toThrow(
      "DrizzleTransactionManager run options must be a non-array object",
    );
    expect(transaction).not.toHaveBeenCalled();
  }
});

test("run normalizes throwing retry getters before database work", async () => {
  const { database, transaction } = fakeDatabase();
  const manager = new DrizzleTransactionManager(database, () => ({}));
  const secret = "provider-private-run-option";
  const options = {
    get retry(): "safe" {
      throw new Error(`retry getter failed with ${secret}`);
    },
  };

  const error = await manager
    .run(async () => "committed", options)
    .then(
      () => {
        throw new Error("transaction unexpectedly succeeded");
      },
      (caught: unknown) => caught,
    );

  expect(error).toBeInstanceOf(TypeError);
  expect(String(error)).toContain(
    "DrizzleTransactionManager run options could not be read",
  );
  expect(String(error)).not.toContain(secret);
  expect((error as Error).cause).toBeUndefined();
  expect(transaction).not.toHaveBeenCalled();
});

test("run snapshots retry mode exactly once before replay-safe execution", async () => {
  const { database, transaction } = fakeDatabase();
  const sleep = mock(async (_delayMs: number) => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
  );
  let retryReads = 0;
  const options = {
    get retry() {
      retryReads += 1;
      return "safe" as const;
    },
  };
  let attempts = 0;

  const result = await manager.run(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw codedError("40001");
    }
    return "committed";
  }, options);

  expect(result).toBe("committed");
  expect(retryReads).toBe(1);
  expect(transaction).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(1);
});

test("run rejects unsupported retry modes before database work", async () => {
  for (const retry of [null, false, 0, "sometimes", {}, []]) {
    const { database, transaction } = fakeDatabase();
    const manager = new DrizzleTransactionManager(database, () => ({}));

    await expect(
      manager.run(async () => "committed", {
        retry,
      } as unknown as TransactionRunOptions),
    ).rejects.toThrow(
      'DrizzleTransactionManager retry must be "never" or "safe"',
    );
    expect(transaction).not.toHaveBeenCalled();
  }
});

test("run rejects non-callable operations before database work", async () => {
  for (const operation of [null, "operation", 1, true, {}, []]) {
    const { database, transaction } = fakeDatabase();
    const manager = new DrizzleTransactionManager(database, () => ({}));

    await expect(
      manager.run(
        operation as unknown as (unitOfWork: object) => Promise<unknown>,
      ),
    ).rejects.toThrow("DrizzleTransactionManager operation must be callable");
    expect(transaction).not.toHaveBeenCalled();
  }
});
