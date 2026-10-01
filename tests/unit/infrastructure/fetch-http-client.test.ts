import { expect, test } from "bun:test";
import { z } from "zod";
import type { RequestContext } from "../../../src/core/context/request-context";
import type { HttpRequest, SchemaParser } from "../../../src/core/http/http-client";
import { AppError } from "../../../src/core/errors/app-error";
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
    traceState: "vendor=value",
  },
  startedAt: 0,
};

test("fetch wrapper propagates tracing headers and validates the response", async () => {
  let captured: Request | undefined;
  let capturedRedirect: RequestRedirect | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    captured = new Request(input, init);
    capturedRedirect = init?.redirect;
    return Response.json({ id: "550e8400-e29b-41d4-a716-446655440000", name: "Lamy" });
  };
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl,
  });

  const response = await client.request(
    { method: "GET", path: "/users/1", context },
    z.object({ id: z.uuid(), name: z.string() }),
  );

  expect(response.data.name).toBe("Lamy");
  expect(captured?.headers.get("x-request-id")).toBe(context.requestId);
  expect(captured?.headers.get("traceparent")).toBe(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  expect(captured?.headers.get("tracestate")).toBe("vendor=value");
  expect(capturedRedirect).toBe("manual");
});

test("fetch wrapper surfaces redirects after discarding their response body", async () => {
  let cancelledBodies = 0;
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelledBodies += 1;
        },
      }),
      {
        status: 302,
        headers: { location: "https://evil.example/redirected" },
      },
    );
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl,
  });

  await expect(client.request({ method: "GET", path: "/redirect" }, z.unknown())).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    message: "Upstream request failed",
    details: undefined,
    diagnostics: { status: 302, host: "example.test" },
  });
  expect(cancelledBodies).toBe(1);
});

test("response-body cleanup failures do not replace the upstream HTTP failure", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cleanup failed with private upstream details");
        },
      }),
      { status: 400 },
    );
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl,
  });

  await expect(client.request({ method: "GET", path: "/bad-request" }, z.unknown())).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    message: "Upstream request failed",
    details: undefined,
    diagnostics: { status: 400, host: "example.test" },
  });
});

test("fetch wrapper rejects invalid top-level runtime request shapes before network access", async () => {
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });
  const throwingRequest = Object.defineProperty({}, "method", {
    get() {
      throw new Error("private request getter failure");
    },
  });
  const throwingHeadersRequest = Object.defineProperties(
    {},
    {
      method: { value: "GET" },
      path: { value: "/resource" },
      headers: {
        get() {
          throw new Error("private headers getter failure");
        },
      },
    },
  );
  const invalidRequests: unknown[] = [
    null,
    undefined,
    "GET /resource",
    42,
    true,
    () => undefined,
    [],
    throwingRequest,
    throwingHeadersRequest,
  ];

  for (const request of invalidRequests) {
    await expect(
      client.request(request as HttpRequest, z.unknown()),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP request was invalid",
      details: undefined,
      diagnostics: { host: "example.test" },
    });
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper snapshots runtime request properties exactly once", async () => {
  let methodReads = 0;
  let pathReads = 0;
  let contextReads = 0;
  const runtimeRequest = Object.defineProperties(
    {},
    {
      method: {
        get() {
          methodReads += 1;
          if (methodReads > 1) {
            throw new Error("method getter evaluated twice");
          }
          return "GET";
        },
      },
      path: {
        get() {
          pathReads += 1;
          if (pathReads > 1) {
            throw new Error("path getter evaluated twice");
          }
          return "/resource";
        },
      },
      context: {
        get() {
          contextReads += 1;
          if (contextReads > 1) {
            throw new Error("context getter evaluated twice");
          }
          return undefined;
        },
      },
    },
  ) as unknown as HttpRequest;

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => Response.json({ ok: true }),
  });

  const response = await client.request(
    runtimeRequest,
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
  expect(methodReads).toBe(1);
  expect(pathReads).toBe(1);
  expect(contextReads).toBe(1);
});

test("fetch wrapper normalizes non-string runtime paths before network access", async () => {
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });
  const request = {
    method: "GET",
    path: { secret: "private-path-value" },
  } as unknown as HttpRequest;

  await expect(client.request(request, z.unknown())).rejects.toMatchObject({
    code: "INVALID_HTTP_PATH",
    status: 400,
    message: "HttpClient path must be an absolute path on the configured upstream host",
    details: undefined,
  });
  expect(fetchCalls).toBe(0);
});

test("fetch wrapper rejects invalid runtime request correlation context before network access", async () => {
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });

  const validTrace = {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  };

  const throwingRequestIdContext = Object.defineProperty(
    { trace: validTrace, startedAt: 0 },
    "requestId",
    {
      get() {
        throw new Error("private request id getter failure");
      },
    },
  );
  const throwingTraceContext = Object.defineProperty(
    { requestId: "request-123", startedAt: 0 },
    "trace",
    {
      get() {
        throw new Error("private trace getter failure");
      },
    },
  );
  const throwingTraceId = Object.defineProperty(
    { spanId: validTrace.spanId, traceFlags: validTrace.traceFlags },
    "traceId",
    {
      get() {
        throw new Error("private trace id getter failure");
      },
    },
  );
  const throwingTraceState = Object.defineProperty(
    {
      traceId: validTrace.traceId,
      spanId: validTrace.spanId,
      traceFlags: validTrace.traceFlags,
    },
    "traceState",
    {
      get() {
        throw new Error("private trace state getter failure");
      },
    },
  );

  const invalidContexts: unknown[] = [
    null,
    throwingRequestIdContext,
    throwingTraceContext,
    { requestId: "request-123", trace: throwingTraceId, startedAt: 0 },
    { requestId: "request-123", trace: throwingTraceState, startedAt: 0 },
    { requestId: "bad\r\nInjected: yes", trace: validTrace, startedAt: 0 },
    { requestId: "x".repeat(129), trace: validTrace, startedAt: 0 },
    {
      requestId: "request-123",
      trace: { ...validTrace, traceId: "4BF92F3577B34DA6A3CE929D0E0E4736" },
      startedAt: 0,
    },
    {
      requestId: "request-123",
      trace: { ...validTrace, spanId: "0000000000000000" },
      startedAt: 0,
    },
    {
      requestId: "request-123",
      trace: { ...validTrace, traceFlags: "zz" },
      startedAt: 0,
    },
    {
      requestId: "request-123",
      trace: { ...validTrace, traceState: 42 },
      startedAt: 0,
    },
  ];

  for (const runtimeContext of invalidContexts) {
    const request = {
      method: "GET",
      path: "/resource",
      context: runtimeContext,
    } as unknown as HttpRequest;

    await expect(client.request(request, z.unknown())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP request context was invalid",
      details: undefined,
      diagnostics: { host: "example.test" },
    });
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper snapshots runtime correlation context fields exactly once", async () => {
  const reads = {
    requestId: 0,
    trace: 0,
    traceId: 0,
    spanId: 0,
    traceFlags: 0,
    traceState: 0,
  };
  const runtimeTrace = Object.defineProperties(
    {},
    {
      traceId: {
        get() {
          reads.traceId += 1;
          if (reads.traceId > 1) throw new Error("traceId getter evaluated twice");
          return "4bf92f3577b34da6a3ce929d0e0e4736";
        },
      },
      spanId: {
        get() {
          reads.spanId += 1;
          if (reads.spanId > 1) throw new Error("spanId getter evaluated twice");
          return "00f067aa0ba902b7";
        },
      },
      traceFlags: {
        get() {
          reads.traceFlags += 1;
          if (reads.traceFlags > 1) throw new Error("traceFlags getter evaluated twice");
          return "01";
        },
      },
      traceState: {
        get() {
          reads.traceState += 1;
          if (reads.traceState > 1) throw new Error("traceState getter evaluated twice");
          return "vendor=value";
        },
      },
    },
  );
  const runtimeContext = Object.defineProperties(
    { startedAt: 0 },
    {
      requestId: {
        get() {
          reads.requestId += 1;
          if (reads.requestId > 1) throw new Error("requestId getter evaluated twice");
          return "request-123";
        },
      },
      trace: {
        get() {
          reads.trace += 1;
          if (reads.trace > 1) throw new Error("trace getter evaluated twice");
          return runtimeTrace;
        },
      },
    },
  ) as unknown as RequestContext;

  let capturedHeaders: Headers | undefined;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ ok: true });
    },
  });

  const response = await client.request(
    {
      method: "GET",
      path: "/resource",
      context: runtimeContext,
    },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
  expect(capturedHeaders?.get("x-request-id")).toBe("request-123");
  expect(capturedHeaders?.get("traceparent")).toBe(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  expect(capturedHeaders?.get("tracestate")).toBe("vendor=value");
  expect(reads).toEqual({
    requestId: 1,
    trace: 1,
    traceId: 1,
    spanId: 1,
    traceFlags: 1,
    traceState: 1,
  });
});

test("fetch wrapper rejects absolute paths so callers cannot override the configured host", async () => {
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl: fetch,
  });

  await expect(
    client.request({ method: "GET", path: "https://evil.example/data" }, z.unknown()),
  ).rejects.toMatchObject({ code: "INVALID_HTTP_PATH" });
});

test("fetch wrapper rejects path forms that URL parsing could reinterpret as another origin", async () => {
  const fetchImpl = async () => Response.json({ ok: true });
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl,
  });

  for (const path of [
    "/\\\\evil.example/private",
    "/\n/evil.example/private",
    "/\t/evil.example/private",
    "/\r/evil.example/private",
  ]) {
    await expect(
      client.request({ method: "GET", path }, z.unknown()),
    ).rejects.toMatchObject({ code: "INVALID_HTTP_PATH" });
  }
});

test("fetch wrapper rejects same-origin paths whose raw meaning would be normalized", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  for (const path of [
    "/safe/\tvalue",
    "/safe/\nvalue",
    "/safe/\rvalue",
    "/safe/\u0000value",
    "/users#private-fragment",
    "/api/../admin",
    "/api/%2e%2e/admin",
    "/api/.%2E/admin",
  ]) {
    await expect(
      client.request({ method: "GET", path }, z.unknown()),
    ).rejects.toMatchObject({ code: "INVALID_HTTP_PATH" });
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper allows encoded path data and dot-like non-segments", async () => {
  let captured: URL | undefined;
  const fetchImpl: FetchLike = async (input) => {
    captured = new URL(input.toString());
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await client.request(
    {
      method: "GET",
      path: "/safe/%23fragment/%2evalue?next=../still-query-data",
    },
    z.object({ ok: z.boolean() }),
  );

  expect(captured?.pathname).toBe("/safe/%23fragment/%2evalue");
  expect(captured?.search).toBe("?next=../still-query-data");
});

test("fetch wrapper keeps normalized safe paths on the configured origin", async () => {
  let captured: URL | undefined;
  const fetchImpl: FetchLike = async (input) => {
    captured = new URL(input.toString());
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await client.request(
    { method: "GET", path: "/safe/%5Cvalue?next=%2F%2Fevil.example" },
    z.object({ ok: z.boolean() }),
  );

  expect(captured?.origin).toBe("https://example.test");
  expect(captured?.pathname).toBe("/safe/%5Cvalue");
});

test("fetch wrapper normalizes syntactically invalid base URLs", () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  for (const baseUrl of ["", "not a url", "https://"]) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl,
          logger,
          fetchImpl: fetch,
        }),
    ).toThrow(new RangeError("baseUrl must be a valid absolute URL"));
  }
});

test("fetch wrapper rejects non-HTTP base URLs", () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  expect(
    () =>
      new FetchHttpClient({
        baseUrl: "ftp://example.test",
        logger,
        fetchImpl: fetch,
      }),
  ).toThrow(RangeError);
});

test("fetch wrapper rejects base URLs with path, query, or fragment components", () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  for (const baseUrl of [
    "https://example.test/api",
    "https://example.test/?region=private",
    "https://example.test/#internal",
  ]) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl,
          logger,
          fetchImpl: fetch,
        }),
    ).toThrow(RangeError);
  }
});

test("fetch wrapper accepts canonical origin URLs with or without a trailing slash", () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  for (const baseUrl of ["https://example.test", "https://example.test/"]) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl,
          logger,
          fetchImpl: fetch,
        }),
    ).not.toThrow();
  }
});

test("fetch wrapper rejects base URLs with embedded credentials", () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  expect(
    () =>
      new FetchHttpClient({
        baseUrl: "https://user:secret@example.test",
        logger,
        fetchImpl: fetch,
      }),
  ).toThrow(RangeError);
});


test("fetch wrapper omits invalid application-provided tracestate", async () => {
  let captured: Request | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true });
  };
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl,
  });
  const invalidContext: RequestContext = {
    ...context,
    trace: {
      ...context.trace,
      traceState: "vendor=value,vendor=duplicate",
    },
  };

  await client.request(
    { method: "GET", path: "/trace", context: invalidContext },
    z.object({ ok: z.boolean() }),
  );

  expect(captured?.headers.get("traceparent")).toBe(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  expect(captured?.headers.get("tracestate")).toBeNull();
});

test("fetch wrapper rejects successful responses with a non-JSON media type", async () => {
  let cancelled = 0;
  const encoder = new TextEncoder();
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":true}'));
        },
        cancel() {
          cancelled += 1;
        },
      }),
      {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await expect(
    client.request(
      { method: "GET", path: "/wrong-media-type" },
      z.object({ ok: z.boolean() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
    message: "Upstream response did not use a JSON media type",
    details: undefined,
    diagnostics: { host: "example.test" },
  });
  expect(cancelled).toBe(1);
});

test("fetch wrapper rejects successful JSON bodies with a missing content type", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "" },
    });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await expect(
    client.request(
      { method: "GET", path: "/missing-media-type" },
      z.object({ ok: z.boolean() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
  });
});

test("fetch wrapper rejects ambiguous combined Content-Type values", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8, text/html",
      },
    });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await expect(
    client.request(
      { method: "GET", path: "/ambiguous-media-type" },
      z.object({ ok: z.boolean() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
    message: "Upstream response did not use a JSON media type",
    details: undefined,
    diagnostics: { host: "example.test" },
  });
});

test("fetch wrapper accepts commas inside quoted media-type parameters", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: {
        "content-type": 'application/problem+json; profile="urn:example:a,b"',
      },
    });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  const response = await client.request(
    { method: "GET", path: "/quoted-media-type-parameter" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
});

test("fetch wrapper rejects malformed quoted Content-Type parameters", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: {
        "content-type": 'application/json; profile="unterminated',
      },
    });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await expect(
    client.request(
      { method: "GET", path: "/malformed-media-type" },
      z.object({ ok: z.boolean() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
  });
});

test("fetch wrapper accepts structured syntax JSON media types", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  const response = await client.request(
    { method: "GET", path: "/structured-json" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
});

test("fetch wrapper rejects chunked successful responses that exceed the configured byte limit", async () => {
  let cancelled = 0;
  const encoder = new TextEncoder();
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"value":"'));
          controller.enqueue(encoder.encode("x".repeat(64)));
          controller.enqueue(encoder.encode('"}'));
        },
        cancel() {
          cancelled += 1;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxResponseBytes: 32,
  });

  await expect(
    client.request(
      { method: "GET", path: "/large" },
      z.object({ value: z.string() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
    message: "Upstream response exceeded maximum size",
    details: undefined,
    diagnostics: { host: "example.test" },
  });
  expect(cancelled).toBe(1);
});

test("oversized response cleanup does not wait for a hanging reader cancellation", async () => {
  let releaseCancel: (() => void) | undefined;
  let cancelStarted = false;
  const encoder = new TextEncoder();
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"value":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'));
        },
        cancel() {
          cancelStarted = true;
          return new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxResponseBytes: 16,
  });

  const outcome = client
    .request(
      { method: "GET", path: "/large-hanging-cancel" },
      z.object({ value: z.string() }),
    )
    .then(
      () => ({ kind: "resolved" as const }),
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
  expect(result).toMatchObject({
    kind: "rejected",
    error: {
      code: "UPSTREAM_RESPONSE_INVALID",
      status: 502,
      message: "Upstream response exceeded maximum size",
    },
  });
});

test("request response limit can be lower than the adapter default", async () => {
  const fetchImpl: FetchLike = async () => Response.json({ value: "1234567890" });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxResponseBytes: 1_024,
  });

  await expect(
    client.request(
      { method: "GET", path: "/small", maxResponseBytes: 8 },
      z.object({ value: z.string() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
  });
});

test("fetch wrapper rejects successful JSON bodies with invalid UTF-8", async () => {
  const invalidUtf8Json = new Uint8Array([
    0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22,
    0xc3, 0x28,
    0x22, 0x7d,
  ]);
  const fetchImpl: FetchLike = async () =>
    new Response(invalidUtf8Json, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxResponseBytes: 64,
  });

  await expect(
    client.request(
      { method: "GET", path: "/invalid-utf8" },
      z.object({ value: z.string() }),
    ),
  ).rejects.toMatchObject({
    code: "UPSTREAM_RESPONSE_INVALID",
    status: 502,
    message: "Upstream returned invalid JSON",
    details: undefined,
    diagnostics: { host: "example.test" },
  });
});

test("fetch wrapper parses chunked JSON within the configured byte limit", async () => {
  const encoder = new TextEncoder();
  const fetchImpl: FetchLike = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"ok":'));
          controller.enqueue(encoder.encode("true}"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxResponseBytes: 64,
  });

  const response = await client.request(
    { method: "GET", path: "/bounded" },
    z.object({ ok: z.boolean() }),
  );

  expect(response.data).toEqual({ ok: true });
});

test("fetch wrapper rejects invalid response byte limits", async () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl: "https://example.test",
          logger,
          defaultMaxResponseBytes: invalid,
        }),
    ).toThrow(RangeError);
  }

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await expect(
    client.request(
      { method: "GET", path: "/invalid-limit", maxResponseBytes: 0 },
      z.unknown(),
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP request controls were invalid",
    diagnostics: { host: "example.test" },
  });
});

test("fetch wrapper rejects oversized serialized request bodies before any network attempt", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxRequestBytes: 24,
  });

  await expect(
    client.request(
      {
        method: "POST",
        path: "/large-request",
        body: { value: "x".repeat(64) },
        retry: "never",
      },
      z.object({ ok: z.boolean() }),
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP request body exceeded maximum size",
    details: undefined,
    diagnostics: { host: "example.test" },
  });
  expect(fetchCalls).toBe(0);
});

test("request-specific outbound body limit overrides the adapter default", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
    defaultMaxRequestBytes: 1_024,
  });

  await expect(
    client.request(
      {
        method: "POST",
        path: "/small-request",
        body: { value: "1234567890" },
        maxRequestBytes: 8,
        retry: "never",
      },
      z.object({ ok: z.boolean() }),
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP request body exceeded maximum size",
  });
  expect(fetchCalls).toBe(0);
});

test("request serialization failures are normalized without attempting fetch", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;

  for (const body of [circular, { value: 1n }, () => undefined]) {
    await expect(
      client.request(
        {
          method: "POST",
          path: "/invalid-request",
          body,
          retry: "never",
        },
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP request body could not be serialized",
      details: undefined,
      diagnostics: { host: "example.test" },
    });
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper rejects invalid outbound request byte limits", async () => {
  const logger = new JsonConsoleLogger({}, () => undefined);

  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(
      () =>
        new FetchHttpClient({
          baseUrl: "https://example.test",
          logger,
          defaultMaxRequestBytes: invalid,
        }),
    ).toThrow(RangeError);
  }

  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl: async () => Response.json({ ok: true }),
  });
  await expect(
    client.request(
      {
        method: "POST",
        path: "/invalid-request-limit",
        body: { ok: true },
        maxRequestBytes: 0,
        retry: "never",
      },
      z.unknown(),
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP request controls were invalid",
    diagnostics: { host: "example.test" },
  });
});

test("fetch wrapper rejects invalid runtime response schemas before network access", async () => {
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ created: true });
    },
  });
  const throwingSchema = Object.defineProperty({}, "parse", {
    get() {
      throw new Error("schema getter failure");
    },
  });

  for (const invalidSchema of [null, {}, { parse: "not-callable" }, throwingSchema]) {
    await expect(
      client.request(
        {
          method: "POST",
          path: "/resource",
          body: { operation: "create" },
          retry: "never",
        },
        invalidSchema as unknown as SchemaParser<unknown>,
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP response schema was invalid",
      details: undefined,
      diagnostics: { host: "example.test" },
    });
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper rejects invalid runtime retry modes before network access", async () => {
  let fetchCalls = 0;
  let policyCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
    retryPolicy: {
      nextDelay: () => {
        policyCalls += 1;
        return 0;
      },
    },
  });

  const request = {
    method: "GET",
    path: "/resource",
    retry: "always",
  } as unknown as HttpRequest;

  await expect(client.request(request, z.unknown())).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP retry mode was invalid",
    details: undefined,
    diagnostics: { host: "example.test" },
  });

  expect(fetchCalls).toBe(0);
  expect(policyCalls).toBe(0);
});

test("fetch wrapper rejects unsupported runtime methods before network access", async () => {
  let fetchCalls = 0;
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl: async () => {
      fetchCalls += 1;
      return Response.json({ ok: true });
    },
  });

  const request = {
    method: "get",
    path: "/resource",
    body: { unsafe: true },
  } as unknown as HttpRequest;

  await expect(client.request(request, z.unknown())).rejects.toMatchObject({
    code: "INTERNAL_ERROR",
    status: 500,
    message: "Outbound HTTP method was invalid",
    details: undefined,
  });
  expect(fetchCalls).toBe(0);
});

test("fetch wrapper rejects GET and HEAD bodies before network access or retry", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  for (const method of ["GET", "HEAD"] as const) {
    try {
      await client.request(
        {
          method,
          path: "/resource",
          body: { credential: "top-secret-value" },
        },
        z.unknown(),
      );
      throw new Error("expected GET/HEAD body to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        continue;
      }
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.status).toBe(500);
      expect(error.message).toBe("Outbound HTTP GET/HEAD requests cannot include a body");
      expect(error.details).toBeUndefined();
      expect(error.diagnostics).toEqual({ host: "example.test" });
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("top-secret-value");
    }
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper normalizes invalid application headers before network access", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  for (const headers of [
    { "bad header": "value" },
    { authorization: "Bearer top-secret\r\nInjected: yes" },
  ]) {
    try {
      await client.request(
        {
          method: "GET",
          path: "/headers",
          headers,
        },
        z.object({ ok: z.boolean() }),
      );
      throw new Error("expected invalid outbound headers to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        continue;
      }
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.status).toBe(500);
      expect(error.message).toBe("Outbound HTTP request headers were invalid");
      expect(error.details).toBeUndefined();
      expect(error.diagnostics).toEqual({ host: "example.test" });
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("top-secret");
    }
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper rejects caller-controlled transport headers before network access", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  for (const name of [
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Connection",
    "Keep-Alive",
    "TE",
    "Trailer",
    "Upgrade",
    "Expect",
    "Proxy-Connection",
    "Traceparent",
    "Tracestate",
    "X-Request-Id",
  ]) {
    await expect(
      client.request(
        {
          method: "GET",
          path: "/headers",
          headers: { [name]: "attacker-controlled-value" },
        },
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP request included transport-owned headers",
      details: undefined,
      diagnostics: { host: "example.test" },
    });
  }

  expect(fetchCalls).toBe(0);
});

test("caller correlation headers cannot override or survive adapter-owned context", async () => {
  let fetchCalls = 0;
  const fetchImpl: FetchLike = async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  for (const headers of [
    { "x-request-id": "attacker-request-id" },
    { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
    { tracestate: "attacker=state" },
  ]) {
    await expect(
      client.request(
        {
          method: "GET",
          path: "/headers",
          headers,
          context,
        },
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Outbound HTTP request included transport-owned headers",
      details: undefined,
      diagnostics: { host: "example.test" },
    });
  }

  expect(fetchCalls).toBe(0);
});

test("fetch wrapper preserves application-owned authorization and custom headers", async () => {
  let captured: Request | undefined;
  const fetchImpl: FetchLike = async (input, init) => {
    captured = new Request(input, init);
    return Response.json({ ok: true });
  };
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger: new JsonConsoleLogger({}, () => undefined),
    fetchImpl,
  });

  await client.request(
    {
      method: "GET",
      path: "/headers",
      headers: {
        authorization: "Bearer opaque-token",
        cookie: "session=opaque-session",
        "x-application-header": "application-value",
      },
    },
    z.object({ ok: z.boolean() }),
  );

  expect(captured?.headers.get("authorization")).toBe("Bearer opaque-token");
  expect(captured?.headers.get("cookie")).toBe("session=opaque-session");
  expect(captured?.headers.get("x-application-header")).toBe("application-value");
});

