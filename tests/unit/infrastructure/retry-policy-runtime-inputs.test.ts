import { expect, test } from "bun:test";
import type { HttpRequest } from "../../../src/core/http/http-client";
import {
  DefaultRetryPolicy,
  type RetryFailure,
} from "../../../src/infrastructure/http/retry-policy";

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

test("nextDelay normalizes revoked request proxies", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();

  expect(() =>
    policy.nextDelay(proxy as HttpRequest, 1, { kind: "network" }),
  ).toThrow("DefaultRetryPolicy request could not be read");
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

test("nextDelay rejects invalid runtime failure containers with a stable error", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });

  for (const runtimeFailure of [null, undefined, "failure", 1, true, [], () => undefined]) {
    expect(() =>
      policy.nextDelay(request, 1, runtimeFailure as unknown as RetryFailure),
    ).toThrow("DefaultRetryPolicy failure must be a non-array object");
  }
});

test("nextDelay normalizes throwing failure getters", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const failures = [
    {
      get kind(): RetryFailure["kind"] {
        throw new Error("private-kind-detail");
      },
    },
    {
      kind: "response",
      get status(): number {
        throw new Error("private-status-detail");
      },
    },
    {
      kind: "response",
      status: 503,
      get headers(): Headers {
        throw new Error("private-headers-detail");
      },
    },
  ];

  for (const failure of failures) {
    expect(() => policy.nextDelay(request, 1, failure as RetryFailure)).toThrow(
      "DefaultRetryPolicy failure could not be read",
    );
  }
});

test("nextDelay rejects unsupported runtime failure kinds", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });

  for (const kind of ["other", "", null, 1]) {
    expect(() =>
      policy.nextDelay(request, 1, { kind } as unknown as RetryFailure),
    ).toThrow("DefaultRetryPolicy failure kind must be network or response");
  }
});

test("retry short-circuits do not inspect irrelevant failure input", () => {
  const policy = new DefaultRetryPolicy({ maxRetries: 0, random: () => 0.5 });
  const throwingFailure = {
    get kind(): RetryFailure["kind"] {
      throw new Error("failure should not be read");
    },
  } as RetryFailure;

  expect(policy.nextDelay(request, 1, throwingFailure)).toBeNull();

  const nonRetryableRequest: HttpRequest = { method: "POST", path: "/resource" };
  const defaultPolicy = new DefaultRetryPolicy({ random: () => 0.5 });
  expect(defaultPolicy.nextDelay(nonRetryableRequest, 1, throwingFailure)).toBeNull();
});

test("nextDelay rejects malformed retry response headers with a stable error", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const headersValues = [null, "headers", 1, true, [], {}, { get: 1 }];

  for (const headers of headersValues) {
    expect(() =>
      policy.nextDelay(request, 1, {
        kind: "response",
        status: 503,
        headers,
      } as unknown as RetryFailure),
    ).toThrow("DefaultRetryPolicy response headers were invalid");
  }
});

test("nextDelay normalizes retry header lookup failures", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const headersValues = [
    {
      get get(): Headers["get"] {
        throw new Error("private-getter-detail");
      },
    },
    {
      get() {
        throw new Error("private-method-detail");
      },
    },
  ];

  for (const headers of headersValues) {
    expect(() =>
      policy.nextDelay(request, 1, {
        kind: "response",
        status: 503,
        headers,
      } as unknown as RetryFailure),
    ).toThrow("DefaultRetryPolicy response headers were invalid");
  }
});

test("nextDelay rejects non-string Retry-After runtime values", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });

  for (const value of [1, true, {}, []]) {
    expect(() =>
      policy.nextDelay(request, 1, {
        kind: "response",
        status: 503,
        headers: { get: () => value },
      } as unknown as RetryFailure),
    ).toThrow("DefaultRetryPolicy response headers were invalid");
  }
});

test("nextDelay resolves Retry-After lookup once and preserves its receiver", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  let getReads = 0;
  const headers = {
    marker: "headers-receiver",
    get get() {
      getReads += 1;
      if (getReads > 1) {
        throw new Error("get read twice");
      }
      return function (this: { marker: string }, name: string): string | null {
        expect(this.marker).toBe("headers-receiver");
        expect(name).toBe("retry-after");
        return "2";
      };
    },
  };

  expect(
    policy.nextDelay(request, 1, {
      kind: "response",
      status: 503,
      headers,
    } as unknown as RetryFailure),
  ).toBe(2_000);
  expect(getReads).toBe(1);
});

test("non-retryable response status does not inspect headers", () => {
  const policy = new DefaultRetryPolicy({ random: () => 0.5 });
  const failure = {
    kind: "response",
    status: 500,
    get headers(): Headers {
      throw new Error("headers should not be read");
    },
  } as RetryFailure;

  expect(policy.nextDelay(request, 1, failure)).toBeNull();
});
