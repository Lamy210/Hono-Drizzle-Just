import { expect, test } from "bun:test";
import { z } from "zod";
import type { HttpRequest } from "../../../src/core/http/http-client";
import {
  FetchHttpClient,
  type FetchHttpClientOptions,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
import type { RetryPolicy } from "../../../src/infrastructure/http/retry-policy";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

function logger() {
  return new JsonConsoleLogger({}, () => undefined);
}

test("constructor rejects invalid default timeout values", () => {
  for (const invalidTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl: "https://example.test",
          logger: logger(),
          defaultTimeoutMs: invalidTimeoutMs,
        }),
    ).toThrow(RangeError);

    expect(
      () =>
        new FetchHttpClient({
          baseUrl: "https://example.test",
          logger: logger(),
          defaultAttemptTimeoutMs: invalidTimeoutMs,
        }),
    ).toThrow(RangeError);
  }
});

test("request rejects invalid timeout overrides before calling fetch", async () => {
  let attempts = 0;
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
  });

  for (const invalidTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      client.request(
        { method: "GET", path: "/resource", timeoutMs: invalidTimeoutMs },
        z.unknown(),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    await expect(
      client.request(
        { method: "GET", path: "/resource", attemptTimeoutMs: invalidTimeoutMs },
        z.unknown(),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  }

  expect(attempts).toBe(0);
});

test("attempt timeout is capped by the remaining total deadline", async () => {
  let nowMs = 0;
  let attempts = 0;
  const requestedTimeouts: number[] = [];

  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      nowMs = 700;
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };
  const retryPolicy: RetryPolicy = {
    nextDelay: (_request, _attempt, failure) =>
      failure.kind === "response" && failure.status === 503 ? 0 : null,
  };

  const options = {
    baseUrl: "https://example.test",
    logger: logger(),
    fetchImpl,
    defaultTimeoutMs: 1_000,
    retryPolicy,
    now: () => nowMs,
    signalFactory: (timeoutMs: number) => {
      requestedTimeouts.push(timeoutMs);
      return new AbortController().signal;
    },
  } as FetchHttpClientOptions & {
    signalFactory: (timeoutMs: number) => AbortSignal;
  };
  const client = new FetchHttpClient(options);

  const request = {
    method: "GET",
    path: "/resource",
    timeoutMs: 1_000,
    attemptTimeoutMs: 400,
  } as HttpRequest & { attemptTimeoutMs: number };

  const response = await client.request(request, z.object({ ok: z.boolean() }));

  expect(response.data.ok).toBe(true);
  expect(requestedTimeouts).toEqual([400, 300]);
});
