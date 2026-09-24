import { expect, test } from "bun:test";
import type { Meter } from "../../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../../src/core/observability/tracer";
import { UserCreationIdempotencyObserver } from "../../../../src/modules/users/infrastructure/user-creation-idempotency-observer";

class RecordingMeter implements Meter {
  readonly counters: Array<{
    name: string;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.counters.push({ name, value, ...(attributes ? { attributes } : {}) });
  }

  record(): void {}
}

test("records successful cleanup runs and deleted rows with bounded attributes", async () => {
  const meter = new RecordingMeter();
  const observer = new UserCreationIdempotencyObserver(meter);

  expect(await observer.cleanup(async () => 17)).toBe(17);

  expect(meter.counters).toEqual([
    {
      name: "idempotency.cleanup.rows",
      value: 17,
      attributes: {
        "idempotency.backend": "postgresql",
        "idempotency.operation": "users.create",
      },
    },
    {
      name: "idempotency.cleanup.runs",
      value: 1,
      attributes: {
        "idempotency.backend": "postgresql",
        "idempotency.operation": "users.create",
        "idempotency.cleanup.result": "success",
      },
    },
  ]);
});

test("records zero-row cleanup as a successful run without emitting a zero row counter", async () => {
  const meter = new RecordingMeter();
  const observer = new UserCreationIdempotencyObserver(meter);

  expect(await observer.cleanup(async () => 0)).toBe(0);

  expect(meter.counters).toEqual([
    {
      name: "idempotency.cleanup.runs",
      value: 1,
      attributes: {
        "idempotency.backend": "postgresql",
        "idempotency.operation": "users.create",
        "idempotency.cleanup.result": "success",
      },
    },
  ]);
});

test("records cleanup failures without leaking error text and rethrows", async () => {
  const meter = new RecordingMeter();
  const observer = new UserCreationIdempotencyObserver(meter);
  const error = new Error("cleanup failed for tenant-secret and raw-key");

  await expect(observer.cleanup(async () => {
    throw error;
  })).rejects.toBe(error);

  expect(meter.counters).toEqual([
    {
      name: "idempotency.cleanup.runs",
      value: 1,
      attributes: {
        "idempotency.backend": "postgresql",
        "idempotency.operation": "users.create",
        "idempotency.cleanup.result": "error",
      },
    },
  ]);
  expect(JSON.stringify(meter.counters)).not.toContain("tenant-secret");
  expect(JSON.stringify(meter.counters)).not.toContain("raw-key");
});
