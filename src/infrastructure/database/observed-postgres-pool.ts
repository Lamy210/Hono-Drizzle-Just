import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { Meter, MetricOptions } from "../../core/observability/meter";
import { isDatabaseAcquireTimeout } from "./database-error";

export type DatabasePoolNow = () => number;

export interface ObservedPostgresPoolOptions {
  readonly meter: Meter;
  readonly poolName: string;
  readonly now?: DatabasePoolNow;
}

interface NormalizedObservedPostgresPoolOptions {
  readonly record: Meter["record"];
  readonly increment: Meter["increment"];
  readonly poolName: string;
  readonly now: DatabasePoolNow;
}

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

function requireObject(
  value: unknown,
  invalidMessage: string,
  unreadableMessage: string,
): object {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(invalidMessage);
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError(unreadableMessage);
  }
  if (isArray) {
    throw new TypeError(invalidMessage);
  }

  return value;
}

function normalizeObservation(options: unknown): NormalizedObservedPostgresPoolOptions {
  const container = requireObject(
    options,
    "Database pool observability options must be an object",
    "Database pool observability options could not be read",
  );

  let meter: unknown;
  let poolName: unknown;
  let now: unknown;
  try {
    meter = Reflect.get(container, "meter");
    poolName = Reflect.get(container, "poolName");
    now = Reflect.get(container, "now");
  } catch {
    throw new TypeError("Database pool observability options could not be read");
  }

  if (typeof poolName !== "string" || poolName.length < 1 || poolName.length > 128) {
    throw new TypeError("Database pool name must contain 1 to 128 characters");
  }
  if (now !== undefined && typeof now !== "function") {
    throw new TypeError("Database pool observability now must be callable");
  }

  const meterObject = requireObject(
    meter,
    "Database pool observability meter must be an object",
    "Database pool observability meter could not be read",
  );

  let record: unknown;
  try {
    record = Reflect.get(meterObject, "record");
  } catch {
    throw new TypeError("Database pool observability meter record could not be read");
  }
  if (typeof record !== "function") {
    throw new TypeError("Database pool observability meter record must be callable");
  }

  let increment: unknown;
  try {
    increment = Reflect.get(meterObject, "increment");
  } catch {
    throw new TypeError("Database pool observability meter increment could not be read");
  }
  if (typeof increment !== "function") {
    throw new TypeError("Database pool observability meter increment must be callable");
  }

  return {
    record: (name, value, attributes, metricOptions) =>
      Reflect.apply(record, meterObject, [name, value, attributes, metricOptions]) as void,
    increment: (name, value, attributes, metricOptions) =>
      Reflect.apply(increment, meterObject, [name, value, attributes, metricOptions]) as void,
    poolName,
    now: (now as DatabasePoolNow | undefined) ?? performance.now.bind(performance),
  };
}

export class ObservedPostgresPool extends Pool {
  private readonly now: DatabasePoolNow;
  private readonly record: Meter["record"];
  private readonly increment: Meter["increment"];
  private readonly attributes: { readonly "db.client.connection.pool.name": string };

  constructor(config: PoolConfig, observation: ObservedPostgresPoolOptions) {
    super(config);
    const normalized = normalizeObservation(observation);
    this.now = normalized.now;
    this.record = normalized.record;
    this.increment = normalized.increment;
    this.attributes = {
      "db.client.connection.pool.name": normalized.poolName,
    };
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const startedAt = this.readNowBestEffort();
    const creatingNewConnection = this.idleCount === 0 && this.totalCount < this.options.max;

    if (callback) {
      super.connect((error, client, done) => {
        if (error !== undefined || client === undefined) {
          this.observeAcquisitionFailure(error);
          callback(error, client, done);
          return;
        }

        const acquiredAt = this.readNowBestEffort();
        const release = this.observeSuccessfulAcquisition(
          client,
          startedAt,
          acquiredAt,
          creatingNewConnection,
        );
        callback(undefined, client, release);
      });
      return undefined;
    }

    return super.connect().then(
      (client) => {
        const acquiredAt = this.readNowBestEffort();
        this.observeSuccessfulAcquisition(client, startedAt, acquiredAt, creatingNewConnection);
        return client;
      },
      (error: unknown) => {
        this.observeAcquisitionFailure(error);
        throw error;
      },
    );
  }

  private readNowBestEffort(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private observeSuccessfulAcquisition(
    client: PoolClient,
    startedAt: number | undefined,
    acquiredAt: number | undefined,
    createdNewConnection: boolean,
  ): (error?: unknown) => void {
    if (startedAt !== undefined && acquiredAt !== undefined && acquiredAt >= startedAt) {
      const acquisitionSeconds = (acquiredAt - startedAt) / 1_000;
      this.recordMetric("db.client.connection.wait_time", acquisitionSeconds, {
        unit: "s",
        description: "Time taken to obtain an open connection from the PostgreSQL pool.",
      });

      if (createdNewConnection) {
        this.recordMetric("db.client.connection.create_time", acquisitionSeconds, {
          unit: "s",
          description: "Time taken to create a new PostgreSQL pool connection.",
        });
      }
    }

    const originalRelease = client.release;
    let released = false;
    const release = (error?: unknown): void => {
      if (!released) {
        released = true;
        const releasedAt = this.readNowBestEffort();
        if (acquiredAt !== undefined && releasedAt !== undefined && releasedAt >= acquiredAt) {
          this.recordMetric(
            "db.client.connection.use_time",
            (releasedAt - acquiredAt) / 1_000,
            {
              unit: "s",
              description: "Time between borrowing and returning a PostgreSQL pool connection.",
            },
          );
        }
      }
      (originalRelease as (releaseError?: unknown) => void)(error);
    };
    client.release = release;
    return release;
  }

  private observeAcquisitionFailure(error: unknown): void {
    if (isDatabaseAcquireTimeout(error)) {
      this.incrementMetric("db.client.connection.timeouts", 1, {
        unit: "{timeout}",
        description: "Connection timeouts while obtaining a PostgreSQL pool connection.",
      });
    }
  }

  private recordMetric(name: string, value: number, options: MetricOptions): void {
    try {
      this.record(name, value, this.attributes, options);
    } catch {
      // Observability must not change PostgreSQL pool control flow.
    }
  }

  private incrementMetric(name: string, value: number, options: MetricOptions): void {
    try {
      this.increment(name, value, this.attributes, options);
    } catch {
      // Observability must not replace the authoritative PostgreSQL failure.
    }
  }
}
