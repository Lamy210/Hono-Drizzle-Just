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
  const fetchImpl: FetchLike = async (input, init) => {
    captured = new Request(input, init);
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
