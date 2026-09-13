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
    logger: new JsonConsoleLogger({}, () => undefined),
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
