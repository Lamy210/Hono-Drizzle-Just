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
  expect(capturedRedirect).toBe("manual");
});

test("fetch wrapper surfaces redirects instead of following them", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/redirected" },
    });
  const logger = new JsonConsoleLogger({}, () => undefined);
  const client = new FetchHttpClient({
    baseUrl: "https://example.test",
    logger,
    fetchImpl,
  });

  await expect(client.request({ method: "GET", path: "/redirect" }, z.unknown())).rejects.toMatchObject({
    code: "UPSTREAM_REQUEST_FAILED",
    details: { status: 302, host: "example.test" },
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
