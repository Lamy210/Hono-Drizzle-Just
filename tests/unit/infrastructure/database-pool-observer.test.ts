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
        poolName: "primary",
        maxConnections: 0,
      }),
  ).toThrow(TypeError);
});
