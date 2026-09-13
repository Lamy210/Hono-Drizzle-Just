import { expect, test } from "bun:test";
import { z } from "zod";
import type { RequestContext } from "../../../src/core/context/request-context";
import {
  FetchHttpClient,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
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
