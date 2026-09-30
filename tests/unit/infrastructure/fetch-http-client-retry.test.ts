import { expect, test } from "bun:test";
import { z } from "zod";
import type { HttpRequest } from "../../../src/core/http/http-client";
import {
  FetchHttpClient,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

test("invalid custom retry delays fail closed and discard the response body", async () => {
  for (const invalidDelay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let policyCalls = 0;
    let cancelledBodies = 0;
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelledBodies += 1;
          },
        }),
        { status: 503 },
      );
    const client = new FetchHttpClient({
      baseUrl: "https://example.test",
      logger: new JsonConsoleLogger({}, () => undefined),
      fetchImpl,
      retryPolicy: {
        nextDelay: () => {
          policyCalls += 1;
          return invalidDelay;
        },
      },
    });

    await expect(
      client.request({ method: "GET", path: "/resource" }, z.unknown()),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP retry policy returned an invalid delay",
      diagnostics: { host: "example.test" },
    });

    expect(policyCalls).toBe(1);
    expect(cancelledBodies).toBe(1);
  }
});

test("custom retry policy exceptions are normalized once and discard the response body", async () => {
  let policyCalls = 0;
  let cancelledBodies = 0;
  const failure = new Error("policy failed with private details");
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelledBodies += 1;
        },
      }),
      { status: 503 },
    );
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        throw failure;
      },
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP retry policy failed",
    diagnostics: { host: "example.test" },
  });

  expect(policyCalls).toBe(1);
  expect(cancelledBodies).toBe(1);
});

test("invalid custom retry delays after network failures fail closed", async () => {
  let policyCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      throw new TypeError("connection reset");
    },
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        return -5;
      },
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP retry policy returned an invalid delay",
  });
  expect(policyCalls).toBe(1);
});

test("successful responses never enter custom retry policy", async () => {
  let attempts = 0;
  let policyCalls = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return Response.json({ ok: true }, { status: 201 });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        return 0;
      },
    },
  });

  const response = await client.request(
    {
      method: "POST",
      path: "/resource",
      body: { name: "Lamy" },
      retry: "idempotent",
    },
    z.object({ ok: z.boolean() }),
  );

  expect(response.status).toBe(201);
  expect(response.data).toEqual({ ok: true });
  expect(attempts).toBe(1);
  expect(policyCalls).toBe(0);
});

test("successful responses are not failed by a throwing custom retry policy", async () => {
  let attempts = 0;
  let policyCalls = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        throw new Error("policy should not observe successful responses");
      },
    },
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.status).toBe(200);
  expect(response.data).toEqual({ ok: true });
  expect(attempts).toBe(1);
  expect(policyCalls).toBe(0);
});

test("GET discards a retryable response body before the next attempt", async () => {
  let attempts = 0;
  let cancelledBodies = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(
        new ReadableStream({
          cancel() {
            cancelledBodies += 1;
          },
        }),
        { status: 503 },
      );
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 1_000,
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data.ok).toBe(true);
  expect(attempts).toBe(2);
  expect(cancelledBodies).toBe(1);
});

test("GET retries every configured transient upstream status", async () => {
  for (const status of [408, 429, 502, 503, 504]) {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("transient", { status });
      }
      return Response.json({ ok: true });
    };

    const client = new FetchHttpClient({
      baseUrl: "https://example.test",
      logger: new JsonConsoleLogger({}, () => undefined),
      fetchImpl,
      defaultTimeoutMs: 1_000,
    });

    const response = await client.request(
      { method: "GET", path: "/resource" },
      z.object({ ok: z.boolean() }),
    );

    expect(response.data.ok).toBe(true);
    expect(attempts).toBe(2);
  }
});

test("GET retries a network failure before surfacing an upstream error", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError("connection reset");
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 1_000,
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data.ok).toBe(true);
  expect(attempts).toBe(2);
});

test("OPTIONS retries transient upstream responses by default", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 1_000,
  });

  const response = await client.request(
    { method: "OPTIONS", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data.ok).toBe(true);
  expect(attempts).toBe(2);
});

test("retry does not wait for a hanging response-body cancellation", async () => {
  let attempts = 0;
  let releaseCancel: (() => void) | undefined;
  let cancelStarted = false;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response(
        new ReadableStream({
          cancel() {
            cancelStarted = true;
            return new Promise<void>((resolve) => {
              releaseCancel = resolve;
            });
          },
        }),
        { status: 503 },
      );
    }
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    retryPolicy: {
      nextDelay: (_request, _attempt, failure) =>
        failure.kind === "response" && failure.status === 503 ? 0 : null,
    },
  });

  const outcome = client
    .request(
      { method: "GET", path: "/resource" },
      z.object({ ok: z.boolean() }),
    )
    .then(
      (response) => ({ kind: "resolved" as const, response }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

  const settledBeforeCancel = await Promise.race([
    outcome.then(() => true),
    Bun.sleep(25).then(() => false),
  ]);
  releaseCancel?.();
  const result = await outcome;

  expect(cancelStarted).toBe(true);
  expect(settledBeforeCancel).toBe(true);
  expect(attempts).toBe(2);
  expect(result).toMatchObject({
    kind: "resolved",
    response: { data: { ok: true } },
  });
});

test("non-default methods retry only when the caller marks the request idempotent", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 1_000,
  });

  const request: HttpRequest<{ name: string }> = {
    method: "POST",
    path: "/resource",
    body: { name: "Lamy" },
    retry: "idempotent",
  };

  const response = await client.request(request, z.object({ ok: z.boolean() }));

  expect(response.data.ok).toBe(true);
  expect(attempts).toBe(2);
});

test("retry never disables automatic retry for safe methods", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 1_000,
  });

  const request: HttpRequest = {
    method: "GET",
    path: "/resource",
    retry: "never",
  };

  await expect(client.request(request, z.unknown())).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
  });
  expect(attempts).toBe(1);
});

test("client waits for Retry-After before retrying", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 5_000,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data.ok).toBe(true);
  expect(delays).toEqual([2_000]);
});

test("extreme Retry-After is treated as outside the deadline, not a local policy error", async () => {
  let attempts = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      attempts += 1;
      return new Response("busy", {
        status: 429,
        headers: { "retry-after": "9".repeat(400) },
      });
    },
    defaultTimeoutMs: 1_000,
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    status: 502,
    diagnostics: { status: 429, host: "example.test" },
  });
  expect(attempts).toBe(1);
});

test("retry delay that exceeds the total deadline is not attempted", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", {
        status: 429,
        headers: { "retry-after": "2" },
      });
    }
    return Response.json({ ok: true });
  };

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultTimeoutMs: 1_000,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  await expect(
    client.request({ method: "GET", path: "/resource" }, z.unknown()),
  ).rejects.toMatchObject({ code: "UPSTREAM_REQUEST_FAILED" });
  expect(attempts).toBe(1);
  expect(delays).toEqual([]);
});
