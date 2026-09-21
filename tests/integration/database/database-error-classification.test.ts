import { expect, test } from "bun:test";
import { NoopMeter } from "../../../src/core/observability/noop-meter";
import { NoopTracer } from "../../../src/core/observability/noop-tracer";
import { createDatabase } from "../../../src/infrastructure/database/database";
import { DatabaseObserver } from "../../../src/infrastructure/database/database-observer";

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
}

function observer(): DatabaseObserver {
  return new DatabaseObserver({
    tracer: new NoopTracer(),
    meter: new NoopMeter(),
  });
}

test("normalizes a real PostgreSQL lock timeout to DATABASE_BUSY", async () => {
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
    await blocker.query("begin");
    blockerInTransaction = true;
    await blocker.query("lock table users in access exclusive mode");

    await expect(
      observer().operation({ operation: "SELECT", collection: "users" }, () =>
        waiter.query("select 1 from users limit 1"),
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_BUSY",
      message: "Database is temporarily busy",
      status: 503,
      cause: { code: "55P03" },
    });

    await blocker.query("rollback");
    blockerInTransaction = false;
  } finally {
    if (blockerInTransaction) {
      await blocker.query("rollback").catch(() => undefined);
    }
    blocker.release();
    waiter.release();
    await database.close();
  }
});

test("normalizes a real PostgreSQL statement timeout to DATABASE_TIMEOUT", async () => {
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    statementTimeoutMillis: 80,
    lockTimeoutMillis: 0,
    idleInTransactionSessionTimeoutMillis: 0,
  });

  try {
    await expect(
      observer().operation({ operation: "SELECT" }, () =>
        database.pool.query("select pg_sleep(0.2)"),
      ),
    ).rejects.toMatchObject({
      code: "DATABASE_TIMEOUT",
      message: "Database operation timed out",
      status: 504,
      cause: { code: "57014" },
    });
  } finally {
    await database.close();
  }
});

test("normalizes a real pool acquisition timeout to DATABASE_UNAVAILABLE", async () => {
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 40,
    statementTimeoutMillis: 0,
    lockTimeoutMillis: 0,
    idleInTransactionSessionTimeoutMillis: 0,
  });
  const held = await database.pool.connect();

  try {
    await expect(
      observer().operation({ operation: "CONNECT" }, () => database.pool.connect()),
    ).rejects.toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: "Database is temporarily unavailable",
      status: 503,
    });
  } finally {
    held.release();
    await database.close();
  }
});
