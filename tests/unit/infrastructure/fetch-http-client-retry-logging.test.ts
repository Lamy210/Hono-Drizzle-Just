import { expect, mock, test } from "bun:test";
import { z } from "zod";
import type { LogContext, Logger } from "../../../src/core/logging/logger";
import {
  FetchHttpClient,
  type FetchLike,
} from "../../../src/infrastructure/http/fetch-http-client";
import { DefaultRetryPolicy } from "../../../src/infrastructure/http/retry-policy";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

class ThrowingLogger implements Logger {
  debug(): void {}

  info(): void {
    throw new Error("info sink unavailable");
  }

  warn(): void {
    throw new Error("warn sink unavailable");
  }

  error(): void {}

  child(_context: LogContext): Logger {
    return this;
  }
}

test("logger child wiring is validated with stable constructor errors", () => {
  const throwingChildGetter = Object.defineProperty({}, "child", {
    get() {
      throw new Error("private child getter failure");
    },
  });
  const invalidParents: unknown[] = [
    null,
    {},
    { child: "not-callable" },
    throwingChildGetter,
  ];

  for (const logger of invalidParents) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl: "https://example.test",
          logger: logger as Logger,
        }),
    ).toThrow(
      new TypeError("FetchHttpClient logger must provide a callable child() method"),
    );
  }

  expect(
    () =>
      new FetchHttpClient({
        baseUrl: "https://example.test",
        logger: {
          child() {
            throw new Error("private child creation failure");
          },
        } as unknown as Logger,
      }),
  ).toThrow(new TypeError("FetchHttpClient logger.child() failed"));

  const throwingInfoGetter = Object.defineProperty({}, "info", {
    get() {
      throw new Error("private info getter failure");
    },
  });
  const invalidChildren: unknown[] = [
    null,
    {},
    { info: () => undefined, warn: "not-callable" },
    throwingInfoGetter,
  ];
  for (const childLogger of invalidChildren) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl: "https://example.test",
          logger: {
            child() {
              return childLogger as Logger;
            },
          } as unknown as Logger,
        }),
    ).toThrow(
      new TypeError(
        "FetchHttpClient logger.child() must return callable info() and warn() methods",
      ),
    );
  }
});

test("logger child is resolved once with its original receiver", () => {
  let childReads = 0;
  let childCalls = 0;
  let receivedContext: LogContext | undefined;
  let receivedReceiver: unknown;
  const childLogger = new JsonConsoleLogger({}, () => undefined);
  const parent = Object.defineProperty({}, "child", {
    get() {
      childReads += 1;
      if (childReads > 1) {
        throw new Error("child getter must not be evaluated twice");
      }
      return function (this: unknown, context: LogContext): Logger {
        childCalls += 1;
        receivedReceiver = this;
        receivedContext = context;
        return childLogger;
      };
    },
  }) as Logger;

  new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: parent,
  });

  expect(childReads).toBe(1);
  expect(childCalls).toBe(1);
  expect(receivedReceiver).toBe(parent);
  expect(receivedContext).toEqual({
    component: "http_client",
    upstreamHost: "example.test",
  });
});

test("retry and response logs keep upstream paths and resource identifiers out of structured context", async () => {
  let attempts = 0;
  const lines: string[] = [];
  const fetchImpl: FetchLike = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("busy", { status: 503 });
    }
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, (line) => lines.push(line)),
    fetchImpl,
    retryPolicy: new DefaultRetryPolicy({ baseDelayMs: 100, random: () => 0.5 }),
    sleep: async () => undefined,
  });
  const resourceId = "550e8400-e29b-41d4-a716-446655440000";

  await client.request(
    { method: "GET", path: `/resource/${resourceId}` },
    z.object({ ok: z.boolean() }),
  );

  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records).toHaveLength(2);
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "warn",
      message: "http.client.retry",
      method: "GET",
      statusCode: 503,
      attempt: 1,
      nextAttempt: 2,
      delayMs: 50,
      reason: "status",
      upstreamHost: "example.test",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      level: "info",
      message: "http.client.response",
      method: "GET",
      statusCode: 200,
      attempt: 2,
      upstreamHost: "example.test",
    }),
  );

  for (const record of records) {
    expect(record.path).toBeUndefined();
  }
  expect(lines.join("\n")).not.toContain(resourceId);
  expect(lines.join("\n")).not.toContain("/resource/");
});

test("response logging failures do not discard a successful upstream response", async () => {
  let fetchCalls = 0;
  const nextDelay = mock(() => null);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new ThrowingLogger(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
    retryPolicy: { nextDelay },
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
  expect(fetchCalls).toBe(1);
  expect(nextDelay).not.toHaveBeenCalled();
});

test("retry logging failures do not change the retry decision", async () => {
  let fetchCalls = 0;
  const nextDelay = mock((_request, attempt, failure) =>
    failure.kind === "response" && failure.status === 503 && attempt === 1 ? 0 : null,
  );
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new ThrowingLogger(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? new Response("busy", { status: 503 })
        : Response.json({ ok: true });
    },
    retryPolicy: { nextDelay },
  });

  const response = await client.request(
    { method: "GET", path: "/resource" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
  expect(fetchCalls).toBe(2);
  expect(nextDelay).toHaveBeenCalledTimes(1);
});

