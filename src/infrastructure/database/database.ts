import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../db/schema";

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
}

export function createDatabase(options: DatabaseOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];
export type DatabaseSession = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;
