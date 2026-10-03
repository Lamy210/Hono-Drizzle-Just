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

test("nextDelay rejects invalid runtime request containers with a stable error", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });

  for (const runtimeRequest of [null, undefined, "request", 1, true, [], () => undefined]) {
    expect(() =>
      policy.nextDelay(runtimeRequest as unknown as HttpRequest, 1, { kind: "network" }),
    ).toThrow("DefaultRetryPolicy request must be a non-array object");
  }
});

test("nextDelay normalizes throwing request getters", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const runtimeRequest = {
    method: "GET",
    get retry(): HttpRequest["retry"] {
      throw new Error("provider-private-request-detail");
    },
  } as HttpRequest;

  expect(() => policy.nextDelay(runtimeRequest, 1, { kind: "network" })).toThrow(
    "DefaultRetryPolicy request could not be read",
  );
});

test("nextDelay snapshots policy-relevant request fields exactly once", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  let methodReads = 0;
  let retryReads = 0;
  const runtimeRequest = {
    get method(): HttpRequest["method"] {
      methodReads += 1;
      if (methodReads > 1) {
        throw new Error("method read twice");
      }
      return "GET";
    },
    get retry(): HttpRequest["retry"] {
      retryReads += 1;
      if (retryReads > 1) {
        throw new Error("retry read twice");
      }
      return undefined;
    },
  } as HttpRequest;

  expect(policy.nextDelay(runtimeRequest, 1, { kind: "network" })).toBe(50);
  expect({ methodReads, retryReads }).toEqual({ methodReads: 1, retryReads: 1 });
});
