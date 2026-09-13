import { expect, test } from "bun:test";
import { z } from "zod";
import type { HttpMethod, HttpRequest } from "../../../src/core/http/http-client";
import {
  FetchHttpClient,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

test("GET retries a retryable upstream status", async () => {
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
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data.ok).toBe(true);
  expect(attempts).toBe(2);
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

test("safe read-only methods retry transient upstream responses by default", async () => {
  for (const method of ["HEAD", "OPTIONS"] satisfies HttpMethod[]) {
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
      { method, path: "/resource" },
      z.object({ ok: z.boolean() }),
    );

    expect(response.data.ok).toBe(true);
    expect(attempts).toBe(2);
  }
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

  const request = {
    method: "POST",
    path: "/resource",
    body: { name: "Lamy" },
    retry: "idempotent",
  } as HttpRequest<{ name: string }> & { retry: "idempotent" };

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

  const request = {
    method: "GET",
    path: "/resource",
    retry: "never",
  } as HttpRequest & { retry: "never" };

  await expect(client.request(request, z.unknown())).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
  });
  expect(attempts).toBe(1);
});
