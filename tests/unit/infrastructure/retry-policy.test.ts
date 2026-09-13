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
  const options = { now: () => nowMs } as DefaultRetryPolicyOptions & { now: () => number };
  const policy = new DefaultRetryPolicy(options);
  const failure: RetryFailure = {
    kind: "response",
    status: 503,
    headers: new Headers({
      "retry-after": new Date(nowMs + 3_000).toUTCString(),
    }),
  };

  expect(policy.nextDelay(getRequest, 1, failure)).toBe(3_000);
});
