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
    lockTimeoutMillis: 0,
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

test("idle transaction timeout terminates the checked-out backend and the pool recovers", async () => {
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    statementTimeoutMillis: 0,
    lockTimeoutMillis: 0,
    idleInTransactionSessionTimeoutMillis: 80,
  });
  const monitor = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    statementTimeoutMillis: 0,
    lockTimeoutMillis: 0,
    idleInTransactionSessionTimeoutMillis: 0,
  });

  const client = await database.pool.connect();
  let released = false;
  let backendError: Error | undefined;
  client.on("error", (error) => {
    backendError = error;
  });

  try {
    const settings = await client.query<{
      statementTimeout: string;
      idleTransactionTimeout: string;
      backendPid: number;
    }>(`
      select
        current_setting('statement_timeout') as "statementTimeout",
        current_setting('idle_in_transaction_session_timeout') as "idleTransactionTimeout",
        pg_backend_pid() as "backendPid"
    `);
    const setting = settings.rows[0];
    expect(setting).toMatchObject({
      statementTimeout: "0",
      idleTransactionTimeout: "80ms",
    });
    if (!setting) {
      throw new Error("expected PostgreSQL session settings");
    }

    await client.query("begin");

    let backendExists = true;
    for (let attempt = 0; attempt < 40 && backendExists; attempt += 1) {
      await Bun.sleep(25);
      const activity = await monitor.pool.query<{ exists: boolean }>(
        "select exists(select 1 from pg_stat_activity where pid = $1) as exists",
        [setting.backendPid],
      );
      backendExists = activity.rows[0]?.exists ?? false;
    }

    expect(backendExists).toBe(false);
    expect(backendError).toBeInstanceOf(Error);

    client.release(true);
    released = true;

    const healthy = await database.pool.query<{ value: number }>("select 1 as value");
    expect(healthy.rows[0]?.value).toBe(1);
  } finally {
    if (!released) {
      client.release(true);
    }
    await Promise.all([database.close(), monitor.close()]);
  }
});


test("lock timeout aborts only the blocked statement and keeps both sessions usable", async () => {
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 2,
    connectionTimeoutMillis: 500,
    statementTimeoutMillis: 1_000,
    lockTimeoutMillis: 80,
    idleInTransactionSessionTimeoutMillis: 0,
  });

  const blocker = await database.pool.connect();
  const waiter = await database.pool.connect();
  let blockerInTransaction = false;

  try {
    const settings = await waiter.query<{
      statementTimeout: string;
      lockTimeout: string;
    }>(`
      select
        current_setting('statement_timeout') as "statementTimeout",
        current_setting('lock_timeout') as "lockTimeout"
    `);
    expect(settings.rows[0]).toEqual({
      statementTimeout: "1s",
      lockTimeout: "80ms",
    });

    await blocker.query("begin");
    blockerInTransaction = true;
    await blocker.query("lock table users in access exclusive mode");

    await expect(waiter.query("select 1 from users limit 1")).rejects.toMatchObject({
      code: "55P03",
    });

    const waiterHealthy = await waiter.query<{ value: number }>("select 1 as value");
    expect(waiterHealthy.rows[0]?.value).toBe(1);

    await blocker.query("rollback");
    blockerInTransaction = false;

    const unblocked = await waiter.query<{ value: number }>("select 1 as value from users limit 1");
    expect(unblocked.rows[0]?.value).toBe(1);
  } finally {
    if (blockerInTransaction) {
      await blocker.query("rollback").catch(() => undefined);
    }
    blocker.release();
    waiter.release();
    await database.close();
  }
});
