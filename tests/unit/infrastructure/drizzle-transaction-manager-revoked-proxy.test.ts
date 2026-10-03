import { expect, mock, test } from "bun:test";
import type { TransactionRunOptions } from "../../../src/core/transaction/transaction-manager";
import type {
  Database,
  DatabaseSession,
} from "../../../src/infrastructure/database/database";
import {
  DrizzleTransactionManager,
  type DrizzleTransactionManagerOptions,
} from "../../../src/infrastructure/database/drizzle-transaction-manager";

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

test("constructor normalizes revoked option proxies", () => {
  const { database } = fakeDatabase();
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  expect(
    () =>
      new DrizzleTransactionManager(
        database,
        () => ({}),
        undefined,
        proxy as DrizzleTransactionManagerOptions,
      ),
  ).toThrow("DrizzleTransactionManager options could not be read");
});

test("run normalizes revoked option proxies before database work", async () => {
  const { database, transaction } = fakeDatabase();
  const manager = new DrizzleTransactionManager(database, () => ({}));
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  await expect(
    manager.run(
      async () => "committed",
      proxy as TransactionRunOptions,
    ),
  ).rejects.toThrow("DrizzleTransactionManager run options could not be read");
  expect(transaction).not.toHaveBeenCalled();
});
