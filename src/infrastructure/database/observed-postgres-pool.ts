import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { Meter } from "../../core/observability/meter";

export type DatabasePoolNow = () => number;

export interface ObservedPostgresPoolOptions {
  readonly meter: Meter;
  readonly poolName: string;
  readonly now?: DatabasePoolNow;
}

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

function hasAcquireTimeout(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { readonly code?: unknown; readonly cause?: unknown; readonly message?: unknown };
    if (candidate.code === "ETIMEDOUT") {
      return true;
    }
    if (typeof candidate.message === "string" && candidate.message.toLowerCase().includes("timeout")) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

export class ObservedPostgresPool extends Pool {
  private readonly now: DatabasePoolNow;
  private readonly attributes: { readonly "db.client.connection.pool.name": string };

  constructor(config: PoolConfig, private readonly observation: ObservedPostgresPoolOptions) {
    super(config);
    if (observation.poolName.length < 1 || observation.poolName.length > 128) {
      throw new TypeError("Database pool name must contain 1 to 128 characters");
    }
    this.now = observation.now ?? performance.now.bind(performance);
    this.attributes = {
      "db.client.connection.pool.name": observation.poolName,
    };
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const startedAt = this.now();

    if (callback) {
      super.connect((error, client, done) => {
        this.observeAcquisition(startedAt, error);
        callback(error, client, done);
      });
      return;
    }

    return super.connect().then(
      (client) => {
        this.observeAcquisition(startedAt);
        return client;
      },
      (error: unknown) => {
        this.observeAcquisition(startedAt, error);
        throw error;
      },
    );
  }

  private observeAcquisition(startedAt: number, error?: unknown): void {
    if (error === undefined) {
      this.observation.meter.record(
        "db.client.connection.wait_time",
        Math.max(0, this.now() - startedAt) / 1_000,
        this.attributes,
        {
          unit: "s",
          description: "Time taken to obtain an open connection from the PostgreSQL pool.",
        },
      );
      return;
    }

    if (hasAcquireTimeout(error)) {
      this.observation.meter.increment(
        "db.client.connection.timeouts",
        1,
        this.attributes,
        {
          unit: "{timeout}",
          description: "Connection timeouts while obtaining a PostgreSQL pool connection.",
        },
      );
    }
  }
}
