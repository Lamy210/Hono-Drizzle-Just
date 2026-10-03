import { expect, test } from "bun:test";
import type { HttpRequest } from "../../../src/core/http/http-client";
import {
  DefaultRetryPolicy,
  type DefaultRetryPolicyOptions,
  type RetryFailure,
} from "../../../src/infrastructure/http/retry-policy";

const getRequest: HttpRequest = { method: "GET", path: "/resource" };

test("Retry-After delay-seconds controls the retry delay", () => {
  const policy = new DefaultRetryPolicy();
  const failure: RetryFailure = {
    kind: "response",
    status: 429,
    headers: new Headers({ "retry-after": "2" }),
  };

  expect(policy.nextDelay(getRequest, 1, failure)).toBe(2_000);
});

test("extreme Retry-After delay-seconds saturate to a finite delay", () => {
  const policy = new DefaultRetryPolicy();
  const failure: RetryFailure = {
    kind: "response",
    status: 429,
    headers: new Headers({ "retry-after": "9".repeat(400) }),
  };

  expect(policy.nextDelay(getRequest, 1, failure)).toBe(Number.MAX_SAFE_INTEGER);
});

test("Retry-After HTTP-date controls the retry delay", () => {
  const nowMs = Date.parse("2026-09-14T00:00:00.000Z");
  const policy = new DefaultRetryPolicy({ now: () => nowMs });
  const failure: RetryFailure = {
    kind: "response",
    status: 503,
    headers: new Headers({
      "retry-after": new Date(nowMs + 3_000).toUTCString(),
    }),
  };

  expect(policy.nextDelay(getRequest, 1, failure)).toBe(3_000);
});

test("fallback retry delay uses capped exponential backoff with jitter", () => {
  const options = {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    random: () => 0.5,
  } as DefaultRetryPolicyOptions & {
    baseDelayMs: number;
    maxDelayMs: number;
    random: () => number;
  };
  const policy = new DefaultRetryPolicy(options);
  const failure: RetryFailure = { kind: "response", status: 503 };

  expect(policy.nextDelay(getRequest, 1, failure)).toBe(50);
  expect(policy.nextDelay(getRequest, 2, failure)).toBe(100);
  expect(policy.nextDelay(getRequest, 3, failure)).toBeNull();
});

test("constructor rejects invalid runtime option containers", () => {
  for (const options of [null, "options", 1, true, [], () => undefined]) {
    expect(
      () => new DefaultRetryPolicy(options as unknown as DefaultRetryPolicyOptions),
    ).toThrow("DefaultRetryPolicy options must be a non-array object");
  }
});

test("constructor normalizes throwing option getters", () => {
  const options = {
    get maxRetries() {
      return 2;
    },
    get random(): () => number {
      throw new Error("provider-private-detail");
    },
  } as DefaultRetryPolicyOptions;

  expect(() => new DefaultRetryPolicy(options)).toThrow(
    "DefaultRetryPolicy options could not be read",
  );
});

test("constructor snapshots runtime options exactly once", () => {
  const reads = {
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    now: 0,
    random: 0,
  };
  const nowMs = Date.parse("2026-09-14T00:00:00.000Z");
  const options = {
    get maxRetries() {
      reads.maxRetries += 1;
      return 2;
    },
    get baseDelayMs() {
      reads.baseDelayMs += 1;
      return 100;
    },
    get maxDelayMs() {
      reads.maxDelayMs += 1;
      return 1_000;
    },
    get now() {
      reads.now += 1;
      return () => nowMs;
    },
    get random() {
      reads.random += 1;
      return () => 0.5;
    },
  } satisfies DefaultRetryPolicyOptions;

  const policy = new DefaultRetryPolicy(options);

  expect(
    policy.nextDelay(getRequest, 1, {
      kind: "response",
      status: 503,
      headers: new Headers({
        "retry-after": new Date(nowMs + 3_000).toUTCString(),
      }),
    }),
  ).toBe(3_000);
  expect(policy.nextDelay(getRequest, 1, { kind: "network" })).toBe(50);
  expect(reads).toEqual({
    maxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
    now: 1,
    random: 1,
  });
});

test("constructor rejects null numeric options instead of selecting defaults", () => {
  for (const key of ["maxRetries", "baseDelayMs", "maxDelayMs"] as const) {
    expect(
      () =>
        new DefaultRetryPolicy({
          [key]: null,
        } as unknown as DefaultRetryPolicyOptions),
    ).toThrow(RangeError);
  }
});

test("constructor requires explicitly configured hooks to be callable", () => {
  const cases = [
    ["now", "DefaultRetryPolicy now must be callable"],
    ["random", "DefaultRetryPolicy random must be callable"],
  ] as const;

  for (const [key, message] of cases) {
    expect(
      () =>
        new DefaultRetryPolicy({
          [key]: null,
        } as unknown as DefaultRetryPolicyOptions),
    ).toThrow(message);
  }
});

test("now hook failures are normalized without retaining provider exceptions", () => {
  const secret = "private-now-hook-detail";
  const retryAt = Date.parse("2026-09-14T00:00:03.000Z");
  const policy = new DefaultRetryPolicy({
    now: () => {
      throw new Error(`now failed with ${secret}`);
    },
  });

  const error = (() => {
    try {
      policy.nextDelay(getRequest, 1, {
        kind: "response",
        status: 503,
        headers: new Headers({ "retry-after": new Date(retryAt).toUTCString() }),
      });
      throw new Error("nextDelay unexpectedly succeeded");
    } catch (caught) {
      return caught;
    }
  })();

  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({ message: "DefaultRetryPolicy now hook failed" });
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(secret);
});

test("now hook rejects non-finite runtime results", () => {
  const retryAt = Date.parse("2026-09-14T00:00:03.000Z");

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const policy = new DefaultRetryPolicy({ now: () => value });

    expect(() =>
      policy.nextDelay(getRequest, 1, {
        kind: "response",
        status: 503,
        headers: new Headers({ "retry-after": new Date(retryAt).toUTCString() }),
      }),
    ).toThrow("DefaultRetryPolicy now hook must return a finite number");
  }
});

test("random hook failures are normalized without retaining provider exceptions", () => {
  const secret = "private-random-hook-detail";
  const policy = new DefaultRetryPolicy({
    random: () => {
      throw new Error(`random failed with ${secret}`);
    },
  });

  const error = (() => {
    try {
      policy.nextDelay(getRequest, 1, { kind: "network" });
      throw new Error("nextDelay unexpectedly succeeded");
    } catch (caught) {
      return caught;
    }
  })();

  expect(error).toBeInstanceOf(TypeError);
  expect(error).toMatchObject({ message: "DefaultRetryPolicy random hook failed" });
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(secret);
});

test("random hook rejects non-finite runtime results", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const policy = new DefaultRetryPolicy({ random: () => value });

    expect(() => policy.nextDelay(getRequest, 1, { kind: "network" })).toThrow(
      "DefaultRetryPolicy random hook must return a finite number",
    );
  }
});

test("constructor rejects invalid maxRetries values", () => {
  for (const maxRetries of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => new DefaultRetryPolicy({ maxRetries })).toThrow(RangeError);
  }
});

test("constructor rejects invalid delay values", () => {
  for (const baseDelayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new DefaultRetryPolicy({ baseDelayMs })).toThrow(RangeError);
  }

  for (const maxDelayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new DefaultRetryPolicy({ maxDelayMs })).toThrow(RangeError);
  }
});

test("constructor accepts zero retry and delay values", () => {
  const policy = new DefaultRetryPolicy({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 });

  expect(policy.nextDelay(getRequest, 1, { kind: "network" })).toBeNull();
});
