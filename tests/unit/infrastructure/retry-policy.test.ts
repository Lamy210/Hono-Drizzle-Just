import { expect, test } from "bun:test";
import type { HttpRequest } from "../../../src/core/http/http-client";
import {
  DefaultRetryPolicy,
  type RetryFailure,
} from "../../../src/infrastructure/http/retry-policy";

const getRequest: HttpRequest = { method: "GET", path: "/resource" };

test("Retry-After delay-seconds controls the retry delay", () => {
  const policy = new DefaultRetryPolicy();
  const failure = {
    kind: "response",
    status: 429,
    headers: new Headers({ "retry-after": "2" }),
  } as RetryFailure & { headers: Headers };

  expect(policy.nextDelay(getRequest, 1, failure)).toBe(2_000);
});
