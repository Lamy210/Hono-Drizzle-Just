import type {
  ObservableMeter,
  ObservableMeasurement,
} from "../../core/observability/meter";

export interface DatabasePoolState {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface DatabasePoolObserverOptions {
  readonly meter: ObservableMeter;
  readonly pool: DatabasePoolState;
  readonly poolName: string;
  readonly maxConnections: number;
}

export class DatabasePoolObserver {
  constructor(private readonly options: DatabasePoolObserverOptions) {
    if (!Number.isInteger(options.maxConnections) || options.maxConnections < 1) {
      throw new TypeError("Database pool maxConnections must be a positive integer");
    }
    if (options.poolName.length < 1 || options.poolName.length > 128) {
      throw new TypeError("Database pool name must contain 1 to 128 characters");
    }
  }

  observe(): () => void {
    const baseAttributes = {
      "db.client.connection.pool.name": this.options.poolName,
    } as const;

    const unregisterConnections = this.options.meter.observeUpDownCounter(
      "db.client.connection.count",
      (): readonly ObservableMeasurement[] => {
        const total = this.options.pool.totalCount;
        const idle = this.options.pool.idleCount;
        const used = Math.max(0, total - idle);
        return [
          {
            value: idle,
            attributes: {
              ...baseAttributes,
              "db.client.connection.state": "idle",
            },
          },
          {
            value: used,
            attributes: {
              ...baseAttributes,
              "db.client.connection.state": "used",
            },
          },
        ];
      },
      {
        unit: "{connection}",
        description: "Number of PostgreSQL pool connections by current state.",
      },
    );

    const unregisterMax = this.options.meter.observeUpDownCounter(
      "db.client.connection.max",
      () => [
        {
          value: this.options.maxConnections,
          attributes: baseAttributes,
        },
      ],
      {
        unit: "{connection}",
        description: "Maximum number of PostgreSQL pool connections.",
      },
    );

    const unregisterPending = this.options.meter.observeUpDownCounter(
      "db.client.connection.pending_requests",
      () => [
        {
          value: this.options.pool.waitingCount,
          attributes: baseAttributes,
        },
      ],
      {
        unit: "{request}",
        description: "Number of requests currently waiting for a PostgreSQL pool connection.",
      },
    );

    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      unregisterPending();
      unregisterMax();
      unregisterConnections();
    };
  }
}
