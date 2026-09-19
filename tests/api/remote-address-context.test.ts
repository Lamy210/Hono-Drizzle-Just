import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createErrorHandler } from "../../src/http/error-handler";
import type { AppEnv } from "../../src/http/env";
import { createRequestContextMiddleware } from "../../src/http/middleware/request-context.middleware";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";

test("remote address comes from the injected transport resolver, not forwarding headers", async () => {
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  const remoteAddressResolver = mock(() => "203.0.113.10");
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, undefined, undefined, remoteAddressResolver));
  app.get("/context", (c) =>
    c.json({ remoteAddress: c.get("requestContext").remoteAddress ?? null }),
  );

  const response = await app.request("/context", {
    headers: {
      forwarded: 'for="198.51.100.7"',
      "x-forwarded-for": "198.51.100.8",
      "x-real-ip": "198.51.100.9",
      "cf-connecting-ip": "198.51.100.10",
    },
  });

  expect(response.status).toBe(200);
  expect(remoteAddressResolver).toHaveBeenCalledTimes(1);
  expect(await response.json()).toEqual({ remoteAddress: "203.0.113.10" });
});

test("remote address resolver failures preserve correlation for the common error handler", async () => {
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    createRequestContextMiddleware(logger, undefined, undefined, () => {
      throw new Error("transport peer lookup failed");
    }),
  );
  app.onError(createErrorHandler());
  app.get("/context", (c) => c.body(null, 204));

  const response = await app.request("/context");

  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toMatchObject({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
});
