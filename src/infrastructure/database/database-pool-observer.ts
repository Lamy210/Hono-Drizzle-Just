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

interface NormalizedDatabasePoolObserverOptions {
  readonly observeUpDownCounter: ObservableMeter["observeUpDownCounter"];
  readonly pool: DatabasePoolState;
  readonly poolName: string;
  readonly maxConnections: number;
}

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

function normalizeOptions(options: unknown): NormalizedDatabasePoolObserverOptions {
  const container = requireObject(
    options,
    "Database pool observer options must be an object",
    "Database pool observer options could not be read",
  );

  let meter: unknown;
  let pool: unknown;
  let poolName: unknown;
  let maxConnections: unknown;
  try {
    meter = Reflect.get(container, "meter");
    pool = Reflect.get(container, "pool");
    poolName = Reflect.get(container, "poolName");
    maxConnections = Reflect.get(container, "maxConnections");
  } catch {
    throw new TypeError("Database pool observer options could not be read");
  }

  if (!Number.isInteger(maxConnections) || (maxConnections as number) < 1) {
    throw new TypeError("Database pool maxConnections must be a positive integer");
  }
  if (typeof poolName !== "string" || poolName.length < 1 || poolName.length > 128) {
    throw new TypeError("Database pool name must contain 1 to 128 characters");
  }

  const meterObject = requireObject(
    meter,
    "Database pool observer meter must be an object",
    "Database pool observer meter could not be read",
  );
  let observeUpDownCounter: unknown;
  try {
    observeUpDownCounter = Reflect.get(meterObject, "observeUpDownCounter");
  } catch {
    throw new TypeError("Database pool observer meter observeUpDownCounter could not be read");
  }
  if (typeof observeUpDownCounter !== "function") {
    throw new TypeError("Database pool observer meter observeUpDownCounter must be callable");
  }

  const poolObject = requireObject(
    pool,
    "Database pool observer pool must be an object",
    "Database pool observer pool could not be read",
  );

  return {
    observeUpDownCounter: (name, callback, metricOptions) =>
      Reflect.apply(observeUpDownCounter, meterObject, [name, callback, metricOptions]) as () => void,
    pool: poolObject as DatabasePoolState,
    poolName,
    maxConnections: maxConnections as number,
  };
}

export class DatabasePoolObserver {
  private readonly observeUpDownCounter: ObservableMeter["observeUpDownCounter"];
  private readonly pool: DatabasePoolState;
  private readonly poolName: string;
  private readonly maxConnections: number;

  constructor(options: DatabasePoolObserverOptions) {
    const normalized = normalizeOptions(options);
    this.observeUpDownCounter = normalized.observeUpDownCounter;
    this.pool = normalized.pool;
    this.poolName = normalized.poolName;
    this.maxConnections = normalized.maxConnections;
  }

  observe(): () => void {
    const baseAttributes = {
      "db.client.connection.pool.name": this.poolName,
    } as const;

    const unregisterConnections = this.observeUpDownCounter(
      "db.client.connection.count",
      (): readonly ObservableMeasurement[] => {
        const total = this.pool.totalCount;
        const idle = this.pool.idleCount;
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

    const unregisterMax = this.observeUpDownCounter(
      "db.client.connection.max",
      () => [
        {
          value: this.maxConnections,
          attributes: baseAttributes,
        },
      ],
      {
        unit: "{connection}",
        description: "Maximum number of PostgreSQL pool connections.",
      },
    );

    const unregisterPending = this.observeUpDownCounter(
      "db.client.connection.pending_requests",
      () => [
        {
          value: this.pool.waitingCount,
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
