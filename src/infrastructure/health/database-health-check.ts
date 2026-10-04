import type { Pool } from "pg";
import type { HealthCheck } from "../../core/health/health-check";

type DatabaseQuery = (text: string) => Promise<unknown>;

function requireTimeoutMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Database health check timeout must be a positive safe integer");
  }
  return value as number;
}

function normalizeDatabaseQuery(pool: unknown): DatabaseQuery {
  if (typeof pool !== "object" || pool === null) {
    throw new TypeError("Database health check pool must be an object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(pool);
  } catch {
    throw new TypeError("Database health check pool query could not be read");
  }
  if (isArray) {
    throw new TypeError("Database health check pool must be an object");
  }

  let query: unknown;
  try {
    query = Reflect.get(pool, "query");
  } catch {
    throw new TypeError("Database health check pool query could not be read");
  }
  if (typeof query !== "function") {
    throw new TypeError("Database health check pool query must be callable");
  }

  return (text: string) => Reflect.apply(query, pool, [text]) as Promise<unknown>;
}

export class DatabaseHealthCheck implements HealthCheck {
  readonly name = "database";
  private inFlight: Promise<void> | undefined;
  private readonly query: DatabaseQuery;
  private readonly timeoutMs: number;

  constructor(pool: Pick<Pool, "query">, timeoutMs: number) {
    this.timeoutMs = requireTimeoutMs(timeoutMs);
    this.query = normalizeDatabaseQuery(pool);
  }

  async check(): Promise<void> {
    const databaseCheck = this.inFlight ?? this.startCheck();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        databaseCheck,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("database readiness check timed out")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private startCheck(): Promise<void> {
    const query = Promise.resolve().then(async () => {
      await this.query("select 1");
    });
    let tracked: Promise<void>;
    tracked = query.finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = tracked;
    return tracked;
  }
}
