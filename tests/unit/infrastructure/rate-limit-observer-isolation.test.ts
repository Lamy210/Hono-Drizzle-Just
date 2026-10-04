import { expect, test } from "bun:test";
import type { Meter } from "../../../src/core/observability/meter";
import { RateLimitObserver } from "../../../src/infrastructure/rate-limit/rate-limit-observer";

class SilentMeter implements Meter {
  increment(): void {}
  record(): void {}
}

class RecordingDurationMeter implements Meter {
  readonly durations: number[] = [];

  increment(): void {}

  record(name: string, value: number): void {
    if (name === "rate_limit.decision.duration") {
      this.durations.push(value);
    }
  }
}

class ThrowingMeter implements Meter {
  increment(): void {
    throw new Error("private-meter-increment-failure");
  }

  record(): void {
    throw new Error("private-meter-record-failure");
  }
}

const descriptor = {
  backend: "postgresql",
  algorithm: "fixed_window",
} as const;

test("decision executes when the observability clock throws before execution", async () => {
  let executeCalls = 0;
  const observer = new RateLimitObserver({
    meter: new SilentMeter(),
    now: () => {
      throw new Error("private-clock-failure");
    },
  });

  const decision = await observer.decision(descriptor, async () => {
    executeCalls += 1;
    return { allowed: true } as const;
  });

  expect(decision).toEqual({ allowed: true });
  expect(executeCalls).toBe(1);
});

test("decision skips duration metrics when the observability clock is non-finite", async () => {
  for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const meter = new RecordingDurationMeter();
    const observer = new RateLimitObserver({ meter, now: () => invalidNow });

    await expect(
      observer.decision(descriptor, async () => ({ allowed: true })),
    ).resolves.toEqual({ allowed: true });
    expect(meter.durations).toEqual([]);
  }
});

test("decision meter failures do not replace a successful decision", async () => {
  const observer = new RateLimitObserver({
    meter: new ThrowingMeter(),
    now: () => 10,
  });

  await expect(
    observer.decision(descriptor, async () => ({ allowed: true })),
  ).resolves.toEqual({ allowed: true });
});

test("decision meter failures do not replace the authoritative error", async () => {
  const observer = new RateLimitObserver({
    meter: new ThrowingMeter(),
    now: () => 10,
  });
  const error = new Error("authoritative-rate-limit-failure");

  await expect(
    observer.decision(descriptor, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

test("cleanup meter failures do not replace a successful cleanup result", async () => {
  const observer = new RateLimitObserver({
    meter: new ThrowingMeter(),
    now: () => 10,
  });

  await expect(observer.cleanup(descriptor, async () => 37)).resolves.toBe(37);
});

test("cleanup meter failures do not replace the authoritative error", async () => {
  const observer = new RateLimitObserver({
    meter: new ThrowingMeter(),
    now: () => 10,
  });
  const error = new Error("authoritative-cleanup-failure");

  await expect(
    observer.cleanup(descriptor, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});
