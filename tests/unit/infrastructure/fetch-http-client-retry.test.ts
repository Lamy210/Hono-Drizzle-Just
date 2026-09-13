import { expect, test } from "bun:test";
import { z } from "zod";
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
