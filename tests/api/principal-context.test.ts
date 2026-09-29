import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PrincipalResolver } from "../../src/core/auth/principal-resolver";
import { AppError } from "../../src/core/errors/app-error";
import { createErrorHandler } from "../../src/http/error-handler";
import type { AppEnv } from "../../src/http/env";
import { createRequestContextMiddleware } from "../../src/http/middleware/request-context.middleware";
import { requestLoggerMiddleware } from "../../src/http/middleware/request-logger.middleware";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";

test("resolved principal is attached to RequestContext", async () => {
  const resolve = mock(async () => ({
    subject: "user-123",
    tenantId: "tenant-456",
    roles: ["admin"],
    scopes: ["users:read", "users:write"],
  }));
  const resolver: PrincipalResolver = { resolve };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, resolver));
  app.get("/context", (c) => c.json({ principal: c.get("requestContext").principal ?? null }));

  const response = await app.request("/context", {
    headers: {
      authorization: "Bearer opaque-token",
      cookie: "session=opaque-session",
    },
  });

  expect(response.status).toBe(200);
  expect(resolve).toHaveBeenCalledWith({
    authorization: "Bearer opaque-token",
    cookie: "session=opaque-session",
  });
  expect(await response.json()).toEqual({
    principal: {
      subject: "user-123",
      tenantId: "tenant-456",
      roles: ["admin"],
      scopes: ["users:read", "users:write"],
    },
  });
});

test("requests stay anonymous when no principal is resolved", async () => {
  const resolver: PrincipalResolver = { resolve: mock(async () => undefined) };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, resolver));
  app.get("/context", (c) => c.json({ authenticated: c.get("requestContext").principal !== undefined }));

  const response = await app.request("/context");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: false });
});

test("resolved principal logs keep only low-cardinality authentication state", async () => {
  const lines: string[] = [];
  const resolver: PrincipalResolver = {
    resolve: mock(async () => ({ subject: "user-123", tenantId: "tenant-456" })),
  };
  const logger = new JsonConsoleLogger({ service: "test" }, (line) => lines.push(line));
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, resolver));
  app.use("*", requestLoggerMiddleware);
  app.get("/context", (c) => {
    c.get("logger").info("auth.context.ready");
    return c.body(null, 204);
  });

  const response = await app.request("/context", {
    headers: {
      authorization: "Bearer super-secret-token",
      cookie: "session=super-secret-cookie",
    },
  });

  expect(response.status).toBe(204);
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    const log = JSON.parse(line);
    expect(log.authenticated).toBe(true);
    expect(line).not.toContain("user-123");
    expect(line).not.toContain("tenant-456");
    expect(line).not.toContain("super-secret-token");
    expect(line).not.toContain("super-secret-cookie");
  }
  expect(lines.some((line) => line.includes('"message":"http.request"'))).toBe(true);
  expect(lines.some((line) => line.includes('"message":"auth.context.ready"'))).toBe(true);
});

test("principal resolver failures keep request correlation available to the error handler", async () => {
  const lines: string[] = [];
  const resolver: PrincipalResolver = {
    resolve: mock(async () => {
      throw new AppError("UNAUTHORIZED", "Invalid credentials", 401);
    }),
  };
  const logger = new JsonConsoleLogger({ service: "test" }, (line) => lines.push(line));
  const app = new Hono<AppEnv>();

  app.use("*", createRequestContextMiddleware(logger, resolver));
  app.onError(createErrorHandler());
  app.get("/context", (c) => c.body(null, 204));

  const response = await app.request("/context", {
    headers: { authorization: "Bearer invalid-secret" },
  });

  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body).toMatchObject({
    error: { code: "UNAUTHORIZED", message: "Invalid credentials" },
  });
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(lines.some((line) => line.includes("http.request.rejected"))).toBe(true);
  expect(lines.some((line) => line.includes("\"level\":\"warn\""))).toBe(true);
  expect(lines.join("\n")).not.toContain("invalid-secret");
});
