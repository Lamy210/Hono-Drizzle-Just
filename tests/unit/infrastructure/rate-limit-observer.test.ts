import { expect, test } from "bun:test";
import type { Meter } from "../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../src/core/observability/tracer";
import { RateLimitObserver } from "../../../src/infrastructure/rate-limit/rate-limit-observer";

class RecordingMeter implements Meter {
  readonly counters: Array<{
    name: string;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];
  readonly records: Array<{
    name: string;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.counters.push({ name, value, ...(attributes ? { attributes } : {}) });
  }

  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.records.push({ name, value, ...(attributes ? { attributes } : {}) });
  }
}

const descriptor = {
  backend: "postgresql",
  algorithm: "fixed_window",
} as const;

test("records an allowed decision with bounded attributes and duration", async () => {
  const meter = new RecordingMeter();
  const times = [1_000, 1_250];
  const observer = new RateLimitObserver({
    meter,
    now: () => times.shift() ?? 1_250,
  });

  const decision = await observer.decision(descriptor, async () => ({ allowed: true }));

  expect(decision).toEqual({ allowed: true });
  expect(meter.counters).toEqual([
    {
      name: "rate_limit.decisions",
      value: 1,
      attributes: {
        "rate_limit.backend": "postgresql",
        "rate_limit.algorithm": "fixed_window",
        "rate_limit.result": "allowed",
      },
    },
  ]);
  expect(meter.records).toEqual([
    {
      name: "rate_limit.decision.duration",
      value: 0.25,
      attributes: {
        "rate_limit.backend": "postgresql",
        "rate_limit.algorithm": "fixed_window",
        "rate_limit.result": "allowed",
      },
    },
  ]);
});

test("records denied decisions without scope or identity cardinality", async () => {
  const meter = new RecordingMeter();
  const observer = new RateLimitObserver({ meter, now: () => 10 });

  await observer.decision(descriptor, async () => ({
    allowed: false,
    retryAfterSeconds: 12,
  }));

  const attributes = meter.counters[0]?.attributes;
  expect(attributes).toEqual({
    "rate_limit.backend": "postgresql",
    "rate_limit.algorithm": "fixed_window",
    "rate_limit.result": "denied",
  });
  const encoded = JSON.stringify(attributes);
  expect(encoded).not.toContain("http.global");
  expect(encoded).not.toContain("203.0.113.10");
  expect(encoded).not.toContain("identity");
});

test("records errors and rethrows the original failure without leaking error text", async () => {
  const meter = new RecordingMeter();
  const observer = new RateLimitObserver({ meter, now: () => 20 });
  const error = new Error("database failed for client 198.51.100.40");

  await expect(
    observer.decision(descriptor, async () => {
      throw error;
    }),
  ).rejects.toBe(error);

  expect(meter.counters[0]).toEqual({
    name: "rate_limit.decisions",
    value: 1,
    attributes: {
      "rate_limit.backend": "postgresql",
      "rate_limit.algorithm": "fixed_window",
      "rate_limit.result": "error",
    },
  });
  expect(JSON.stringify(meter.counters[0])).not.toContain("198.51.100.40");
  expect(JSON.stringify(meter.counters[0])).not.toContain("database failed");
  expect(meter.records[0]?.value).toBe(0);
});

test("records GCRA as a bounded algorithm dimension", async () => {
  const meter = new RecordingMeter();
  const observer = new RateLimitObserver({ meter, now: () => 30 });

  await observer.decision({ backend: "postgresql", algorithm: "gcra" }, async () => ({
    allowed: true,
  }));

  expect(meter.counters[0]?.attributes).toEqual({
    "rate_limit.backend": "postgresql",
    "rate_limit.algorithm": "gcra",
    "rate_limit.result": "allowed",
  });
});

test("records successful cleanup runs and reclaimed rows with bounded attributes", async () => {
  const meter = new RecordingMeter();
  const observer = new RateLimitObserver({ meter, now: () => 10 });

  expect(await observer.cleanup(descriptor, async () => 37)).toBe(37);

  expect(meter.counters).toContainEqual({
    name: "rate_limit.cleanup.rows",
    value: 37,
    attributes: {
      "rate_limit.backend": "postgresql",
      "rate_limit.algorithm": "fixed_window",
    },
  });
  expect(meter.counters).toContainEqual({
    name: "rate_limit.cleanup.runs",
    value: 1,
    attributes: {
      "rate_limit.backend": "postgresql",
      "rate_limit.algorithm": "fixed_window",
      "rate_limit.cleanup.result": "success",
    },
  });
});

test("records zero-row cleanup without emitting a zero-value rows counter", async () => {
  const meter = new RecordingMeter();
  const observer = new RateLimitObserver({ meter, now: () => 10 });

  expect(await observer.cleanup(descriptor, async () => 0)).toBe(0);

  expect(meter.counters).toEqual([
    {
      name: "rate_limit.cleanup.runs",
      value: 1,
      attributes: {
        "rate_limit.backend": "postgresql",
        "rate_limit.algorithm": "fixed_window",
        "rate_limit.cleanup.result": "success",
      },
    },
  ]);
});

test("records cleanup failures without leaking error or request cardinality", async () => {
  const meter = new RecordingMeter();
  const observer = new RateLimitObserver({ meter, now: () => 10 });
  const error = new Error("cleanup failed for http.secret 203.0.113.200");

  await expect(
    observer.cleanup(
      { backend: "postgresql", algorithm: "gcra" },
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);

  expect(meter.counters).toEqual([
    {
      name: "rate_limit.cleanup.runs",
      value: 1,
      attributes: {
        "rate_limit.backend": "postgresql",
        "rate_limit.algorithm": "gcra",
        "rate_limit.cleanup.result": "error",
      },
    },
  ]);
  const serialized = JSON.stringify(meter.counters);
  expect(serialized).not.toContain("http.secret");
  expect(serialized).not.toContain("203.0.113.200");
  expect(serialized).not.toContain("cleanup failed");
});

