import { expect, test } from "bun:test";
import { z } from "zod";
import type { RequestContext } from "../../../src/core/context/request-context";
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
  ).rejects.toBeInstanceOf(RangeError);
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
  ).rejects.toBeInstanceOf(RangeError);
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

