import { expect, mock, test } from "bun:test";
import { createApp } from "../../src/app/app";
import type { HealthCheck } from "../../src/core/health/health-check";
import { ReadinessChecker } from "../../src/core/health/readiness-checker";
import type { TransactionManager } from "../../src/core/transaction/transaction-manager";
import { Sha256StringDigester } from "../../src/infrastructure/crypto/sha256-string-digester";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../src/modules/users/application/create-user.service";
import { DeleteUserService } from "../../src/modules/users/application/delete-user.service";
import { GetUserService } from "../../src/modules/users/application/get-user.service";
import { ListUsersCursorService } from "../../src/modules/users/application/list-users-cursor.service";
import { ListUsersService } from "../../src/modules/users/application/list-users.service";
import { UpdateUserService } from "../../src/modules/users/application/update-user.service";
import type { UserUnitOfWork } from "../../src/modules/users/application/user-unit-of-work";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";
import { userUnitOfWork } from "../helpers/user-unit-of-work";

function transactions(repository: UserRepository): TransactionManager<UserUnitOfWork> {
  return { run: async (operation) => operation(userUnitOfWork(repository)) };
}

function buildApp(healthCheck: HealthCheck) {
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => null),
    create: mock(async (input) => ({
      id: crypto.randomUUID(),
      ...input,
      version: 1,
      createdAt: new Date(),
    })),
  };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  return createApp({
    logger,
    readinessChecker: new ReadinessChecker([healthCheck]),
    deleteUserService: new DeleteUserService(
      { deleteById: mock(async () => ({ state: "not_found" as const })) },
      logger,
    ),
    createUserService: new CreateUserService(
      transactions(repository),
      logger,
      new Sha256StringDigester(),
    ),
    getUserService: new GetUserService(repository),
    listUsersCursorService: new ListUsersCursorService({
      listAfter: mock(async () => ({ users: [], hasMore: false })),
    }),
    listUsersService: new ListUsersService({
      listPage: mock(async () => ({ users: [], total: 0 })),
    }),
    updateUserService: new UpdateUserService(
      { update: mock(async () => ({ state: "not_found" as const })) },
      logger,
    ),
  });
}

test("API responses use a safe default security-header baseline", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });

  const response = await app.request("/health/live");

  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
  expect(response.headers.get("x-download-options")).toBe("noopen");
  expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(response.headers.get("x-permitted-cross-domain-policies")).toBe("none");
  expect(response.headers.get("x-xss-protection")).toBe("0");
  expect(response.headers.get("x-powered-by")).toBeNull();

  expect(response.headers.get("strict-transport-security")).toBeNull();
  expect(response.headers.get("cross-origin-resource-policy")).toBeNull();
  expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
  expect(response.headers.get("origin-agent-cluster")).toBeNull();
});

test("unmatched routes use the common correlated 404 error response", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  const response = await app.request("/missing", {
    headers: {
      "x-request-id": requestId,
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    },
  });

  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    error: { code: "NOT_FOUND", message: "Resource not found" },
    requestId,
    traceId,
  });
});

test("unsupported methods use the common correlated 405 response with Allow", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  const response = await app.request("/health/live", {
    method: "POST",
    headers: {
      "x-request-id": requestId,
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    },
  });

  expect(response.status).toBe(405);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const allow = response.headers.get("allow");
  expect(allow).toContain("GET");
  expect(allow).toContain("HEAD");
  expect(await response.json()).toEqual({
    error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
    requestId,
    traceId,
  });
});

test("health GET and HEAD responses are never cacheable", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });

  for (const path of ["/health", "/health/live", "/health/ready"]) {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      if (method === "HEAD") {
        expect(await response.text()).toBe("");
      }
    }
  }
});

test("liveness stays healthy even when a critical dependency is down", async () => {
  const app = buildApp({
    name: "database",
    check: async () => {
      throw new Error("database unavailable");
    },
  });

  const response = await app.request("/health/live");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("readiness returns 200 when critical dependencies are available", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });

  const response = await app.request("/health/ready");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.status).toBe("ready");
  expect(body.checks.database.status).toBe("up");
});

test("readiness returns 503 instead of 500 when a critical dependency is down", async () => {
  const app = buildApp({
    name: "database",
    check: async () => {
      throw new Error("database unavailable");
    },
  });

  const response = await app.request("/health/ready");
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.status).toBe("not_ready");
  expect(body.checks.database.status).toBe("down");
  expect(JSON.stringify(body)).not.toContain("database unavailable");
});