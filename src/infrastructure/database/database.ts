import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import type { Meter } from "../../core/observability/meter";
import * as schema from "../../db/schema";
import { ObservedPostgresPool, type DatabasePoolNow } from "./observed-postgres-pool";

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly statementTimeoutMillis?: number;
  readonly idleInTransactionSessionTimeoutMillis?: number;
  readonly observability?: {
    readonly meter: Meter;
    readonly poolName: string;
    readonly now?: DatabasePoolNow;
  };
}

export function createDatabase(options: DatabaseOptions) {
  const poolConfig: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    statement_timeout: options.statementTimeoutMillis,
    idle_in_transaction_session_timeout: options.idleInTransactionSessionTimeoutMillis,
  };
  const pool = options.observability
    ? new ObservedPostgresPool(poolConfig, options.observability)
    : new Pool(poolConfig);
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type DatabaseSession = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;
