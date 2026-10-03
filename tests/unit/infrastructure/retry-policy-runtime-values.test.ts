import { expect, test } from "bun:test";
import type { HttpRequest } from "../../../src/core/http/http-client";
import {
  DefaultRetryPolicy,
  type RetryFailure,
} from "../../../src/infrastructure/http/retry-policy";

const networkFailure: RetryFailure = { kind: "network" };

test("nextDelay rejects invalid runtime request method and retry values", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const cases = [
    {
      request: { method: "TRACE", path: "/resource" },
      message: "DefaultRetryPolicy request method was invalid",
    },
    {
      request: { method: "GET", path: "/resource", retry: "sometimes" },
      message: "DefaultRetryPolicy request retry mode was invalid",
    },
  ] as const;

  for (const { request, message } of cases) {
    expect(() =>
      policy.nextDelay(request as unknown as HttpRequest, 1, networkFailure),
    ).toThrow(message);
  }
});

test("nextDelay rejects invalid runtime response status values", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const request: HttpRequest = { method: "GET", path: "/resource" };

  for (const status of ["503", 503.5, Number.NaN, 99, 600]) {
    expect(() =>
      policy.nextDelay(request, 1, {
        kind: "response",
        status,
      } as unknown as RetryFailure),
    ).toThrow("DefaultRetryPolicy response status was invalid");
  }
});
