import { expect, test } from "bun:test";
import { UserCreationIdempotencyCleanupGate } from "../../../../src/modules/users/infrastructure/user-creation-idempotency-cleanup-gate";

test("allows one cleanup per configured interval", () => {
  let now = 1_000;
  const gate = new UserCreationIdempotencyCleanupGate(60_000, () => now);

  expect(gate.acquireIfDue()).toBe(true);
  expect(gate.acquireIfDue()).toBe(false);

  now += 59_999;
  expect(gate.acquireIfDue()).toBe(false);

  now += 1;
  expect(gate.acquireIfDue()).toBe(true);
  expect(gate.acquireIfDue()).toBe(false);
});

test("rejects invalid cleanup configuration and clock values", () => {
  expect(() => new UserCreationIdempotencyCleanupGate(0)).toThrow(RangeError);
  expect(() => new UserCreationIdempotencyCleanupGate(3_600_001)).toThrow(RangeError);

  const gate = new UserCreationIdempotencyCleanupGate(1, () => Number.NaN);
  expect(() => gate.acquireIfDue()).toThrow(TypeError);
});
