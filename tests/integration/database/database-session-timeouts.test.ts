import { expect, test } from "bun:test";
import { createDatabase } from "../../../src/infrastructure/database/database";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
}

test("applies statement timeout per pooled session and keeps the pool usable after cancellation", async () => {
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    statementTimeoutMillis: 80,
    idleInTransactionSessionTimeoutMillis: 0,
  });

  try {
    const settings = await database.pool.query<{
      statementTimeout: string;
      idleTransactionTimeout: string;
    }>(`
      select
        current_setting('statement_timeout') as "statementTimeout",
        current_setting('idle_in_transaction_session_timeout') as "idleTransactionTimeout"
    `);
    expect(settings.rows[0]).toEqual({
      statementTimeout: "80ms",
      idleTransactionTimeout: "0",
    });

    await expect(database.pool.query("select pg_sleep(0.2)")).rejects.toMatchObject({
      code: "57014",
    });

    const healthy = await database.pool.query<{ value: number }>("select 1 as value");
    expect(healthy.rows[0]?.value).toBe(1);
  } finally {
    await database.close();
  }
});

test("idle transaction timeout terminates the checked-out session and the pool recovers", async () => {
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    statementTimeoutMillis: 0,
    idleInTransactionSessionTimeoutMillis: 80,
  });

  const client = await database.pool.connect();
  let released = false;
  try {
    const settings = await client.query<{
      statementTimeout: string;
      idleTransactionTimeout: string;
    }>(`
      select
        current_setting('statement_timeout') as "statementTimeout",
        current_setting('idle_in_transaction_session_timeout') as "idleTransactionTimeout"
    `);
    expect(settings.rows[0]).toEqual({
      statementTimeout: "0",
      idleTransactionTimeout: "80ms",
    });

    const disconnected = new Promise<Error>((resolve) => {
      client.once("error", resolve);
    });

    await client.query("begin");
    const timeoutError = await Promise.race([
      disconnected,
      Bun.sleep(1_000).then(() => undefined),
    ]);
    expect(timeoutError).toBeDefined();
    expect(timeoutError).toMatchObject({ code: "25P03" });

    client.release(timeoutError ?? true);
    released = true;

    const healthy = await database.pool.query<{ value: number }>("select 1 as value");
    expect(healthy.rows[0]?.value).toBe(1);
  } finally {
    if (!released) {
      client.release(true);
    }
    await database.close();
  }
});
