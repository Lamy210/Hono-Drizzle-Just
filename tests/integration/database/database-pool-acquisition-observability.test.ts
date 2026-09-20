import { expect, test } from "bun:test";
import type { Meter, MetricOptions } from "../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../src/core/observability/tracer";
import { createDatabase } from "../../../src/infrastructure/database/database";

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
