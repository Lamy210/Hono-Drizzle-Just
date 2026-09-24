import { expect, mock, test } from "bun:test";
import type { Meter } from "../../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../../src/core/observability/tracer";
import type { Database } from "../../../../src/infrastructure/database/database";
import { DrizzleUserCreationIdempotencyMaintenance } from "../../../../src/modules/users/infrastructure/drizzle-user-creation-idempotency-maintenance";
import { UserCreationIdempotencyCleanupGate } from "../../../../src/modules/users/infrastructure/user-creation-idempotency-cleanup-gate";
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

test("cleanup database failures are observed but do not fail the caller", async () => {
  const failure = new Error("lock timeout for tenant-secret");
  const execute = mock(async () => {
    throw failure;
  });
  const database = { execute } as unknown as Database;
  const meter = new RecordingMeter();
  const gate = new UserCreationIdempotencyCleanupGate(60_000, () => 1_000);
  const maintenance = new DrizzleUserCreationIdempotencyMaintenance(
    database,
    gate,
    undefined,
    new UserCreationIdempotencyObserver(meter),
  );

  await expect(maintenance.cleanupIfDue()).resolves.toBeUndefined();
  await expect(maintenance.cleanupIfDue()).resolves.toBeUndefined();

  expect(execute).toHaveBeenCalledTimes(1);
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
});
