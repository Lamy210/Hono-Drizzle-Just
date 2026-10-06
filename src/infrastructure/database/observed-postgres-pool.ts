import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { Meter, MetricOptions } from "../../core/observability/meter";
import { isDatabaseAcquireTimeout } from "./database-error";

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
  override connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const startedAt = this.now();
    const creatingNewConnection = this.idleCount === 0 && this.totalCount < this.options.max;

    if (callback) {
      super.connect((error, client, done) => {
        if (error !== undefined || client === undefined) {
          this.observeAcquisitionFailure(error);
          callback(error, client, done);
          return;
        }

        const acquiredAt = this.now();
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
        const acquiredAt = this.now();
        this.observeSuccessfulAcquisition(client, startedAt, acquiredAt, creatingNewConnection);
        return client;
      },
      (error: unknown) => {
        this.observeAcquisitionFailure(error);
        throw error;
      },
    );
  }

  private observeSuccessfulAcquisition(
    client: PoolClient,
    startedAt: number,
    acquiredAt: number,
    createdNewConnection: boolean,
  ): (error?: unknown) => void {
    const acquisitionSeconds = Math.max(0, acquiredAt - startedAt) / 1_000;
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

    const originalRelease = client.release;
    let released = false;
    const release = (error?: unknown): void => {
      if (!released) {
        released = true;
        this.recordMetric(
          "db.client.connection.use_time",
          Math.max(0, this.now() - acquiredAt) / 1_000,
          {
            unit: "s",
            description: "Time between borrowing and returning a PostgreSQL pool connection.",
          },
        );
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
      this.observation.meter.record(name, value, this.attributes, options);
    } catch {
      // Observability must not change PostgreSQL pool control flow.
    }
  }

  private incrementMetric(name: string, value: number, options: MetricOptions): void {
    try {
      this.observation.meter.increment(name, value, this.attributes, options);
    } catch {
      // Observability must not replace the authoritative PostgreSQL failure.
    }
  }
}
