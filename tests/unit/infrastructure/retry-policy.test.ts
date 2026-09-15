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

test("constructor rejects invalid maxRetries values", () => {
  for (const maxRetries of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
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
