import { expect, test } from "bun:test";
import type { Meter, MetricOptions } from "../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../src/core/observability/tracer";
import { createDatabase } from "../../../src/infrastructure/database/database";
import {
  ObservedPostgresPool,
  type ObservedPostgresPoolOptions,
} from "../../../src/infrastructure/database/observed-postgres-pool";

interface Measurement {
  readonly name: string;
  readonly value: number;
  readonly attributes?: TelemetryAttributes;
  readonly options?: MetricOptions;
}

class RecordingMeter implements Meter {
  readonly increments: Measurement[] = [];
  readonly records: Measurement[] = [];

  increment(
    name: string,
    value = 1,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    this.increments.push({
      name,
      value,
      ...(attributes === undefined ? {} : { attributes }),
      ...(options === undefined ? {} : { options }),
    });
  }

  record(
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    this.records.push({
      name,
      value,
      ...(attributes === undefined ? {} : { attributes }),
      ...(options === undefined ? {} : { options }),
    });
  }
}

class SelectivelyThrowingMeter extends RecordingMeter {
  constructor(
    private readonly throwOnRecordName?: string,
    private readonly throwOnIncrementName?: string,
  ) {
    super();
  }

  override increment(
    name: string,
    value = 1,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    if (name === this.throwOnIncrementName) {
      throw new Error("observability failure");
    }
    super.increment(name, value, attributes, options);
  }

  override record(
    name: string,
    value: number,
    attributes?: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    if (name === this.throwOnRecordName) {
      throw new Error("observability failure");
    }
    super.record(name, value, attributes, options);
  }
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for integration tests");
  }
  return value;
}

test("Pool.query acquisition records semantic wait time", async () => {
  const meter = new RecordingMeter();
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    observability: { meter, poolName: "primary" },
  });

  try {
    await database.pool.query("select 1");

    const waitTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.wait_time",
    );
    const createTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.create_time",
    );
    const useTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.use_time",
    );
    expect(waitTimes).toHaveLength(1);
    expect(createTimes).toHaveLength(1);
    expect(useTimes).toHaveLength(1);
    expect(waitTimes[0]?.value).toBeGreaterThanOrEqual(0);
    expect(createTimes[0]?.value).toBe(waitTimes[0]?.value);
    expect(useTimes[0]?.value).toBeGreaterThanOrEqual(0);
    expect(waitTimes[0]).toMatchObject({
      attributes: {
        "db.client.connection.pool.name": "primary",
      },
      options: {
        unit: "s",
      },
    });
    expect(createTimes[0]).toMatchObject({
      attributes: {
        "db.client.connection.pool.name": "primary",
      },
      options: {
        unit: "s",
      },
    });
    expect(useTimes[0]).toMatchObject({
      attributes: {
        "db.client.connection.pool.name": "primary",
      },
      options: {
        unit: "s",
      },
    });
    expect(meter.increments).toHaveLength(0);
  } finally {
    await database.close();
  }
});

test("queued acquisition records the time spent waiting for the only pool connection", async () => {
  const meter = new RecordingMeter();
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    observability: { meter, poolName: "primary" },
  });

  const first = await database.pool.connect();
  try {
    const pending = database.pool.connect();
    await Bun.sleep(30);
    expect(database.pool.waitingCount).toBe(1);
    first.release();

    const second = await pending;
    second.release();

    const waitTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.wait_time",
    );
    const createTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.create_time",
    );
    const useTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.use_time",
    );
    expect(waitTimes).toHaveLength(2);
    expect(waitTimes[1]?.value).toBeGreaterThanOrEqual(0.02);
    expect(createTimes).toHaveLength(1);
    expect(useTimes).toHaveLength(2);
    expect(useTimes[0]?.value).toBeGreaterThanOrEqual(0.02);
  } finally {
    if (database.pool.idleCount === 0) {
      first.release();
    }
    await database.close();
  }
});

test("pool acquisition timeout increments only the timeout counter", async () => {
  const meter = new RecordingMeter();
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 40,
    observability: { meter, poolName: "primary" },
  });

  const held = await database.pool.connect();
  try {
    await expect(database.pool.connect()).rejects.toThrow("timeout");

    const timeouts = meter.increments.filter(
      (measurement) => measurement.name === "db.client.connection.timeouts",
    );
    expect(timeouts).toEqual([
      {
        name: "db.client.connection.timeouts",
        value: 1,
        attributes: {
          "db.client.connection.pool.name": "primary",
        },
        options: {
          unit: "{timeout}",
          description: "Connection timeouts while obtaining a PostgreSQL pool connection.",
        },
      },
    ]);

    const waitTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.wait_time",
    );
    const createTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.create_time",
    );
    const useTimes = meter.records.filter(
      (measurement) => measurement.name === "db.client.connection.use_time",
    );
    expect(waitTimes).toHaveLength(1);
    expect(createTimes).toHaveLength(1);
    expect(useTimes).toHaveLength(0);
  } finally {
    held.release();
    await database.close();
  }
});

test("release returns a client to the pool even when use-time metrics fail", async () => {
  const meter = new SelectivelyThrowingMeter("db.client.connection.use_time");
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 500,
    observability: { meter, poolName: "primary" },
  });

  const client = await database.pool.connect();
  try {
    expect(() => client.release()).not.toThrow();
    expect(database.pool.idleCount).toBe(1);
  } finally {
    if (database.pool.idleCount === 0) {
      client.release();
    }
    await database.close();
  }
});

test("timeout metric failures preserve the PostgreSQL acquisition timeout", async () => {
  const meter = new SelectivelyThrowingMeter(undefined, "db.client.connection.timeouts");
  const database = createDatabase({
    connectionString: databaseUrl(),
    max: 1,
    connectionTimeoutMillis: 40,
    observability: { meter, poolName: "primary" },
  });

  const held = await database.pool.connect();
  try {
    await expect(database.pool.connect()).rejects.toThrow("timeout");
  } finally {
    held.release();
    await database.close();
  }
});

test("ObservedPostgresPool validates runtime observability wiring at construction", () => {
  expect(
    () =>
      new ObservedPostgresPool(
        {},
        null as unknown as ObservedPostgresPoolOptions,
      ),
  ).toThrow("Database pool observability options must be an object");

  expect(
    () =>
      new ObservedPostgresPool({}, {
        meter: null as unknown as Meter,
        poolName: "primary",
      }),
  ).toThrow("Database pool observability meter must be an object");

  expect(
    () =>
      new ObservedPostgresPool({}, {
        meter: new RecordingMeter(),
        poolName: 123 as unknown as string,
      }),
  ).toThrow("Database pool name must contain 1 to 128 characters");

  expect(
    () =>
      new ObservedPostgresPool({}, {
        meter: new RecordingMeter(),
        poolName: "primary",
        now: 123 as unknown as () => number,
      }),
  ).toThrow("Database pool observability now must be callable");
});

test("ObservedPostgresPool normalizes throwing observability getters", () => {
  const unreadableOptions = Object.defineProperty({}, "poolName", {
    get() {
      throw new Error("getter failure");
    },
  });
  expect(
    () =>
      new ObservedPostgresPool(
        {},
        unreadableOptions as ObservedPostgresPoolOptions,
      ),
  ).toThrow("Database pool observability options could not be read");

  const unreadableMeter = Object.defineProperty(
    {
      increment() {},
    },
    "record",
    {
      get() {
        throw new Error("getter failure");
      },
    },
  );
  expect(
    () =>
      new ObservedPostgresPool({}, {
        meter: unreadableMeter as unknown as Meter,
        poolName: "primary",
      }),
  ).toThrow("Database pool observability meter record could not be read");
});

test("ObservedPostgresPool snapshots observability hooks and preserves the meter receiver", async () => {
  const recorded = new RecordingMeter();
  let meterReads = 0;
  let poolNameReads = 0;
  let nowReads = 0;
  let recordReads = 0;
  let incrementReads = 0;

  const meter = {
    get record() {
      recordReads += 1;
      return function (
        this: unknown,
        name: string,
        value: number,
        attributes?: TelemetryAttributes,
        options?: MetricOptions,
      ): void {
        expect(this).toBe(meter);
        recorded.record(name, value, attributes, options);
      };
    },
    get increment() {
      incrementReads += 1;
      return function (
        this: unknown,
        name: string,
        value = 1,
        attributes?: TelemetryAttributes,
        options?: MetricOptions,
      ): void {
        expect(this).toBe(meter);
        recorded.increment(name, value, attributes, options);
      };
    },
  };
  const now = () => performance.now();
  const observation = Object.defineProperties(
    {},
    {
      meter: {
        configurable: true,
        get() {
          meterReads += 1;
          return meter;
        },
      },
      poolName: {
        configurable: true,
        get() {
          poolNameReads += 1;
          return "primary";
        },
      },
      now: {
        configurable: true,
        get() {
          nowReads += 1;
          return now;
        },
      },
    },
  ) as ObservedPostgresPoolOptions;

  const pool = new ObservedPostgresPool(
    {
      connectionString: databaseUrl(),
      max: 1,
      connectionTimeoutMillis: 500,
    },
    observation,
  );

  expect(meterReads).toBe(1);
  expect(poolNameReads).toBe(1);
  expect(nowReads).toBe(1);
  expect(recordReads).toBe(1);
  expect(incrementReads).toBe(1);

  Object.defineProperty(observation, "meter", {
    value: new SelectivelyThrowingMeter("db.client.connection.wait_time"),
  });
  Object.defineProperty(meter, "record", {
    value() {
      throw new Error("replacement record must not be used");
    },
  });
  Object.defineProperty(meter, "increment", {
    value() {
      throw new Error("replacement increment must not be used");
    },
  });

  try {
    await pool.query("select 1");
    expect(recorded.records.map((measurement) => measurement.name)).toEqual([
      "db.client.connection.wait_time",
      "db.client.connection.create_time",
      "db.client.connection.use_time",
    ]);
  } finally {
    await pool.end();
  }
});
