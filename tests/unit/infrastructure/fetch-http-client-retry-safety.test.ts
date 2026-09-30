import { expect, test } from "bun:test";
import { z } from "zod";
import type { RequestContext } from "../../../src/core/context/request-context";
import {
  FetchHttpClient,
  type FetchHttpClientOptions,
  type FetchLike,
  type MonotonicNow,
  type SleepLike,
  type TimeoutSignalFactory,
} from "../../../src/infrastructure/http/fetch-http-client";
import type { RetryPolicy } from "../../../src/infrastructure/http/retry-policy";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

const context: RequestContext = {
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  },
  startedAt: 0,
};

function logger() {
  return new JsonConsoleLogger({}, () => undefined);
}

test("retry sleep failures are local adapter errors and do not trigger another fetch", async () => {
  let attempts = 0;
  let sleepCalls = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return new Response("busy", { status: 503 });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
    retryPolicy: {
      nextDelay: () => 25,
    },
    sleep: async () => {
      sleepCalls += 1;
      throw new Error("private scheduler failure");
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP retry delay failed",
    details: undefined,
    diagnostics: { host: "example.test" },
  });

  expect(attempts).toBe(1);
  expect(sleepCalls).toBe(1);
});

test("non-callable fetch hooks fail locally before retry policy evaluation", async () => {
  let policyCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl: {} as unknown as FetchLike,
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        return 0;
      },
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP fetch implementation was invalid",
    details: undefined,
    diagnostics: { host: "example.test" },
  });

  expect(policyCalls).toBe(0);
});

test("null fetch hooks are rejected instead of falling back to global fetch", async () => {
  let signalFactoryCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl: null as unknown as FetchLike,
    signalFactory: () => {
      signalFactoryCalls += 1;
      throw new Error("signal factory should not be reached");
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP fetch implementation was invalid",
    details: undefined,
    diagnostics: { host: "example.test" },
  });

  expect(signalFactoryCalls).toBe(0);
});

test("invalid optional runtime hooks fail locally before network access", async () => {
  const cases: Array<{
    options: Partial<FetchHttpClientOptions>;
    message: string;
  }> = [
    {
      options: { retryPolicy: null as unknown as RetryPolicy },
      message: "Outbound HTTP retry policy was invalid",
    },
    {
      options: { retryPolicy: {} as RetryPolicy },
      message: "Outbound HTTP retry policy was invalid",
    },
    {
      options: { sleep: null as unknown as SleepLike },
      message: "Outbound HTTP retry sleep hook was invalid",
    },
    {
      options: { sleep: {} as unknown as SleepLike },
      message: "Outbound HTTP retry sleep hook was invalid",
    },
    {
      options: { now: null as unknown as MonotonicNow },
      message: "Outbound HTTP monotonic clock hook was invalid",
    },
    {
      options: { now: {} as unknown as MonotonicNow },
      message: "Outbound HTTP monotonic clock hook was invalid",
    },
    {
      options: { signalFactory: null as unknown as TimeoutSignalFactory },
      message: "Outbound HTTP timeout signal factory was invalid",
    },
    {
      options: { signalFactory: {} as unknown as TimeoutSignalFactory },
      message: "Outbound HTTP timeout signal factory was invalid",
    },
  ];

  for (const { options, message } of cases) {
    let fetchCalls = 0;
    const client = new FetchHttpClient({
      ...options,
      baseUrl: "https://example.test",
      logger: logger(),
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      },
    });

    await expect(
      client.request({ method: "GET", path: "/resource" }, z.unknown()),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message,
      details: undefined,
      diagnostics: { host: "example.test" },
    });

    expect(fetchCalls).toBe(0);
  }
});

test("retry policy nextDelay getters are validated before network access", async () => {
  let fetchCalls = 0;
  const retryPolicy = Object.defineProperty({}, "nextDelay", {
    get() {
      throw new Error("private retry policy getter failure");
    },
  }) as RetryPolicy;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("busy", { status: 503 });
    },
    retryPolicy,
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP retry policy was invalid",
    details: undefined,
    diagnostics: { host: "example.test" },
  });

  expect(fetchCalls).toBe(0);
});

test("invalid fetch hook responses fail locally without retrying", async () => {
  let attempts = 0;
  let policyCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl: (async () => {
      attempts += 1;
      return { ok: true, status: 200 } as unknown as Response;
    }) as FetchLike,
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        return 0;
      },
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP fetch implementation returned an invalid response",
    details: undefined,
    diagnostics: { host: "example.test" },
  });

  expect(attempts).toBe(1);
  expect(policyCalls).toBe(0);
});

test("attempt timeout is retryable for safe methods", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new DOMException("attempt timed out", "TimeoutError");
    }
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
    defaultTimeoutMs: 1_000,
    sleep: async () => undefined,
  });

  const response = await client.request(
    { method: "GET", path: "/resource", attemptTimeoutMs: 100 },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data.ok).toBe(true);
  expect(attempts).toBe(2);
});

test("response schema failures are never retried", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return Response.json({ ok: "not-a-boolean" });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
    sleep: async () => undefined,
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.object({ ok: z.boolean() })),
  ).rejects.toMatchObject({ code: "UPSTREAM_RESPONSE_INVALID" });
  expect(attempts).toBe(1);
});

test("HEAD accepts a successful empty response without attempting JSON decoding", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return new Response(null, { status: 200 });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
  });

  const response = await client.request(
    { method: "HEAD", path: "/resource" },
    z.undefined(),
  );

  expect(response.status).toBe(200);
  expect(response.data).toBeUndefined();
  expect(attempts).toBe(1);
});

test("205 accepts a successful empty response without JSON media type or decoding", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return new Response(null, { status: 205 });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
  });

  const response = await client.request(
    { method: "POST", path: "/reset", retry: "never" },
    z.undefined(),
  );

  expect(response.status).toBe(205);
  expect(response.data).toBeUndefined();
  expect(attempts).toBe(1);
});

test("POST does not retry without explicit idempotent opt-in", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return new Response("busy", { status: 503 });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
    sleep: async () => undefined,
  });

  await expect(
    client.request({ method: "POST", path: "/resource", body: { name: "Lamy" } }, z.unknown()),
  ).rejects.toMatchObject({ code: "UPSTREAM_REQUEST_FAILED" });
  expect(attempts).toBe(1);
});

test("request and trace correlation headers stay stable across retries", async () => {
  let attempts = 0;
  const captured: Headers[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    attempts += 1;
    captured.push(new Request(input, init).headers);
    if (attempts === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
    sleep: async () => undefined,
  });

  await client.request(
    { method: "GET", path: "/resource", context },
    z.object({ ok: z.boolean() }),
  );

  expect(captured).toHaveLength(2);
  expect(captured[0]?.get("x-request-id")).toBe(context.requestId);
  expect(captured[1]?.get("x-request-id")).toBe(context.requestId);
  expect(captured[0]?.get("traceparent")).toBe(captured[1]?.get("traceparent"));
});


test("network retry logs omit caller-provided resource paths", async () => {
  let attempts = 0;
  const lines: string[] = [];
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("network unavailable");
    }
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, (line) => lines.push(line)),
    fetchImpl,
    sleep: async () => undefined,
  });

  await client.request(
    {
      method: "GET",
      path: "/users/550e8400-e29b-41d4-a716-446655440000?token=top-secret",
    },
    z.object({ ok: z.boolean() }),
  );

  const retryLog = lines.map((line) => JSON.parse(line)).find((entry) => entry.message === "http.client.retry");
  expect(retryLog).toMatchObject({
    method: "GET",
    attempt: 1,
    nextAttempt: 2,
    reason: "network",
  });
  expect(retryLog.path).toBeUndefined();
  expect(JSON.stringify(retryLog)).not.toContain("550e8400-e29b-41d4-a716-446655440000");
  expect(JSON.stringify(retryLog)).not.toContain("top-secret");
});
