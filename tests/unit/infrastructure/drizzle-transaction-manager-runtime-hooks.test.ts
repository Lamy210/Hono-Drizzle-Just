import { expect, mock, test } from "bun:test";
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

test("random hook failures become stable local errors without another transaction attempt", async () => {
  const { database, transaction } = fakeDatabase();
  const secret = "private-random-hook-detail";
  const sleep = mock(async (_delayMs: number) => undefined);
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    {
      maxAttempts: 2,
      random: () => {
        throw new Error(`random failed with ${secret}`);
      },
      sleep,
    },
  );

  const error = await manager
    .run(
      async () => {
        throw codedError("40001");
      },
      { retry: "safe" },
    )
    .then(
      () => {
        throw new Error("transaction unexpectedly succeeded");
      },
      (caught: unknown) => caught,
    );

  expect(error).toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Database transaction retry random hook failed",
    details: undefined,
  });
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(secret);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("sleep hook failures become stable local errors without another transaction attempt", async () => {
  const { database, transaction } = fakeDatabase();
  const secret = "private-sleep-hook-detail";
  const sleep = mock(async (_delayMs: number) => {
    throw new Error(`sleep failed with ${secret}`);
  });
  const manager = new DrizzleTransactionManager(
    database,
    () => ({}),
    undefined,
    {
      maxAttempts: 2,
      random: () => 0,
      sleep,
    },
  );

  const error = await manager
    .run(
      async () => {
        throw codedError("40P01");
      },
      { retry: "safe" },
    )
    .then(
      () => {
        throw new Error("transaction unexpectedly succeeded");
      },
      (caught: unknown) => caught,
    );

  expect(error).toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Database transaction retry delay failed",
    details: undefined,
  });
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(secret);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(sleep).toHaveBeenCalledTimes(1);
});
