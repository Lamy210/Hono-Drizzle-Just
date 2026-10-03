import { expect, test } from "bun:test";
import type { HttpRequest } from "../../../src/core/http/http-client";
import { DefaultRetryPolicy } from "../../../src/infrastructure/http/retry-policy";

const request: HttpRequest = { method: "GET", path: "/resource" };

test("nextDelay rejects invalid failed-attempt counters before retry calculation", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });

  for (const failedAttempt of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() =>
      policy.nextDelay(request, failedAttempt, { kind: "network" }),
    ).toThrow("failedAttempt must be a positive safe integer");
  }
});
