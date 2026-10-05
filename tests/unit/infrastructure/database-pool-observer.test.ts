import { expect, test } from "bun:test";
import type {
  ObservableMeter,
  ObservableMetricCallback,
  ObservableMetricOptions,
} from "../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../src/core/observability/tracer";
import { DatabasePoolObserver } from "../../../src/infrastructure/database/database-pool-observer";

class RecordingObservableMeter implements ObservableMeter {
  readonly registrations = new Map<
    string,
    {
      callback: ObservableMetricCallback;
      options?: ObservableMetricOptions;
      unregisterCount: number;
    }
  >();

  increment(
    _name: string,
    _value = 1,
    _attributes?: TelemetryAttributes,
  ): void {}

  record(
    _name: string,
    _value: number,
    _attributes?: TelemetryAttributes,
  ): void {}

  observeUpDownCounter(
    name: string,
    callback: ObservableMetricCallback,
    options?: ObservableMetricOptions,
  ): () => void {
    const registration = {
      callback,
      ...(options === undefined ? {} : { options }),
      unregisterCount: 0,
    };
    this.registrations.set(name, registration);
    return () => {
      registration.unregisterCount += 1;
    };
  }
}

test("database pool observer exports current idle, used, max, and pending state", () => {
  const meter = new RecordingObservableMeter();
  const pool = {
    totalCount: 5,
    idleCount: 3,
    waitingCount: 4,
  };
  const observer = new DatabasePoolObserver({
    meter,
    pool,
    poolName: "primary",
    maxConnections: 10,
  });

  const stop = observer.observe();

  expect(meter.registrations.get("db.client.connection.count")?.options).toMatchObject({
    unit: "{connection}",
  });
  expect(meter.registrations.get("db.client.connection.count")?.callback()).toEqual([
    {
      value: 3,
      attributes: {
        "db.client.connection.pool.name": "primary",
        "db.client.connection.state": "idle",
      },
    },
    {
      value: 2,
      attributes: {
        "db.client.connection.pool.name": "primary",
        "db.client.connection.state": "used",
      },
    },
  ]);
  expect(meter.registrations.get("db.client.connection.max")?.callback()).toEqual([
    {
      value: 10,
      attributes: {
        "db.client.connection.pool.name": "primary",
      },
    },
  ]);
  expect(meter.registrations.get("db.client.connection.pending_requests")?.callback()).toEqual([
    {
      value: 4,
      attributes: {
        "db.client.connection.pool.name": "primary",
      },
    },
  ]);

  pool.totalCount = 7;
  pool.idleCount = 1;
  pool.waitingCount = 2;
  expect(meter.registrations.get("db.client.connection.count")?.callback()).toMatchObject([
    { value: 1 },
    { value: 6 },
  ]);
  expect(meter.registrations.get("db.client.connection.pending_requests")?.callback()).toMatchObject([
    { value: 2 },
  ]);

  stop();
  expect(
    [...meter.registrations.values()].every((registration) => registration.unregisterCount === 1),
  ).toBe(true);
});

test("database pool observer rejects invalid static pool metadata", () => {
  const meter = new RecordingObservableMeter();
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 0 };

  expect(
    () =>
      new DatabasePoolObserver({
        meter,
        pool,
        poolName: "",
        maxConnections: 10,
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new DatabasePoolObserver({
        meter,
        pool,
        poolName: 123 as unknown as string,
        maxConnections: 10,
      }),
  ).toThrow("Database pool name must contain 1 to 128 characters");
  expect(
    () =>
      new DatabasePoolObserver({
        meter,
        pool,
        poolName: "primary",
        maxConnections: 0,
      }),
  ).toThrow(TypeError);
});

test("database pool observer rejects malformed runtime wiring at construction", () => {
  const meter = new RecordingObservableMeter();
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 0 };

  expect(
    () =>
      new DatabasePoolObserver(
        null as unknown as ConstructorParameters<typeof DatabasePoolObserver>[0],
      ),
  ).toThrow("Database pool observer options must be an object");
  expect(
    () =>
      new DatabasePoolObserver({
        meter: null as unknown as ObservableMeter,
        pool,
        poolName: "primary",
        maxConnections: 10,
      }),
  ).toThrow("Database pool observer meter must be an object");
  expect(
    () =>
      new DatabasePoolObserver({
        meter: {
          observeUpDownCounter: null,
        } as unknown as ObservableMeter,
        pool,
        poolName: "primary",
        maxConnections: 10,
      }),
  ).toThrow("Database pool observer meter observeUpDownCounter must be callable");
  expect(
    () =>
      new DatabasePoolObserver({
        meter,
        pool: null as unknown as typeof pool,
        poolName: "primary",
        maxConnections: 10,
      }),
  ).toThrow("Database pool observer pool must be an object");
});

test("database pool observer normalizes throwing option getters", () => {
  const meter = new RecordingObservableMeter();
  const pool = { totalCount: 0, idleCount: 0, waitingCount: 0 };
  const options = {
    meter,
    pool,
    poolName: "primary",
    get maxConnections(): number {
      throw new Error("boom");
    },
  };

  expect(() => new DatabasePoolObserver(options)).toThrow(
    "Database pool observer options could not be read",
  );
});

test("database pool observer snapshots static wiring while keeping pool state dynamic", () => {
  const primaryMeter = new RecordingObservableMeter();
  const replacementMeter = new RecordingObservableMeter();
  const primaryPool = { totalCount: 5, idleCount: 3, waitingCount: 4 };
  const replacementPool = { totalCount: 20, idleCount: 10, waitingCount: 8 };
  let currentMeter = primaryMeter;
  let currentPool = primaryPool;
  let currentPoolName = "primary";
  let currentMaxConnections = 10;
  let meterReads = 0;
  let poolReads = 0;
  let poolNameReads = 0;
  let maxConnectionsReads = 0;
  const options = {
    get meter(): ObservableMeter {
      meterReads += 1;
      return currentMeter;
    },
    get pool(): typeof primaryPool {
      poolReads += 1;
      return currentPool;
    },
    get poolName(): string {
      poolNameReads += 1;
      return currentPoolName;
    },
    get maxConnections(): number {
      maxConnectionsReads += 1;
      return currentMaxConnections;
    },
  };

  const observer = new DatabasePoolObserver(options);

  expect({ meterReads, poolReads, poolNameReads, maxConnectionsReads }).toEqual({
    meterReads: 1,
    poolReads: 1,
    poolNameReads: 1,
    maxConnectionsReads: 1,
  });

  currentMeter = replacementMeter;
  currentPool = replacementPool;
  currentPoolName = "replacement";
  currentMaxConnections = 99;

  observer.observe();

  expect(replacementMeter.registrations.size).toBe(0);
  expect(primaryMeter.registrations.get("db.client.connection.max")?.callback()).toEqual([
    {
      value: 10,
      attributes: {
        "db.client.connection.pool.name": "primary",
      },
    },
  ]);
  expect(primaryMeter.registrations.get("db.client.connection.count")?.callback()).toMatchObject([
    { value: 3 },
    { value: 2 },
  ]);

  primaryPool.totalCount = 7;
  primaryPool.idleCount = 1;
  primaryPool.waitingCount = 2;
  expect(primaryMeter.registrations.get("db.client.connection.count")?.callback()).toMatchObject([
    { value: 1 },
    { value: 6 },
  ]);
  expect(
    primaryMeter.registrations.get("db.client.connection.pending_requests")?.callback(),
  ).toMatchObject([{ value: 2 }]);
});
