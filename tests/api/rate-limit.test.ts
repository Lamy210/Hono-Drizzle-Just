import { expect, mock, test } from "bun:test";
import { createApp } from "../../src/app/app";
import { ReadinessChecker } from "../../src/core/health/readiness-checker";
import type { RateLimiter } from "../../src/core/rate-limit/rate-limiter";
import type { TransactionManager } from "../../src/core/transaction/transaction-manager";
import { Sha256StringDigester } from "../../src/infrastructure/crypto/sha256-string-digester";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../src/modules/users/application/create-user.service";
import { DeleteUserService } from "../../src/modules/users/application/delete-user.service";
import { GetUserService } from "../../src/modules/users/application/get-user.service";
import { ListUsersService } from "../../src/modules/users/application/list-users.service";
import { UpdateUserService } from "../../src/modules/users/application/update-user.service";
import type { UserUnitOfWork } from "../../src/modules/users/application/user-unit-of-work";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";
import { userUnitOfWork } from "../helpers/user-unit-of-work";

function transactions(repository: UserRepository): TransactionManager<UserUnitOfWork> {
  return { run: async (operation) => operation(userUnitOfWork(repository)) };
}

function buildApp(rateLimiter?: RateLimiter, remoteAddress?: string) {
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

  return createApp(
    {
      logger,
      readinessChecker: new ReadinessChecker([]),
      deleteUserService: new DeleteUserService({ deleteById: mock(async () => false) }, logger),
      createUserService: new CreateUserService(
        transactions(repository),
        logger,
        new Sha256StringDigester(),
      ),
      getUserService: new GetUserService(repository),
      listUsersService: new ListUsersService({
        listPage: mock(async () => ({ users: [], total: 0 })),
      }),
      updateUserService: new UpdateUserService(
        { update: mock(async () => ({ state: "not_found" as const })) },
        logger,
      ),
      ...(rateLimiter === undefined ? {} : { rateLimiter }),
    },
    remoteAddress === undefined ? {} : { remoteAddressResolver: () => remoteAddress },
  );
}

test("allowed requests expose bounded draft RateLimit fields when quota metadata is available", async () => {
  const consume = mock(
    async () =>
      ({
        allowed: true,
        quota: {
          policyId: "http.global",
          limit: 120,
          remaining: 119,
          windowSeconds: 60,
          resetAfterSeconds: 47,
        },
      }) as const,
  );
  const app = buildApp({ consume }, "203.0.113.10");

  const response = await app.request("/openapi.json");

  expect(response.status).toBe(200);
  expect(response.headers.get("ratelimit-policy")).toBe('"http.global";q=120;w=60');
  expect(response.headers.get("ratelimit")).toBe('"http.global";r=119;t=47');
  expect(consume).toHaveBeenCalledTimes(1);
  expect(consume).toHaveBeenCalledWith({
    scope: "http.global",
    identity: "203.0.113.10",
  });
});

test("user routes select stable read and write scopes without path identifiers", async () => {
  const consume = mock(async () => ({ allowed: true }) as const);
  const app = buildApp({ consume }, "203.0.113.10");
  const userId = "550e8400-e29b-41d4-a716-446655440000";

  const writeResponse = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "rate-limit@example.com", name: "Rate Limit" }),
  });
  const patchResponse = await app.request(`/users/${userId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"v1"' },
    body: JSON.stringify({ name: "Updated" }),
  });
  const deleteResponse = await app.request(`/users/${userId}`, {
    method: "DELETE",
  });
  const listResponse = await app.request("/users");
  const readResponse = await app.request(`/users/${userId}`);

  expect(writeResponse.status).toBe(401);
  expect(patchResponse.status).toBe(401);
  expect(deleteResponse.status).toBe(401);
  expect(listResponse.status).toBe(401);
  expect(readResponse.status).toBe(401);
  expect(consume).toHaveBeenNthCalledWith(1, {
    scope: "http.users.write",
    identity: "203.0.113.10",
  });
  expect(consume).toHaveBeenNthCalledWith(2, {
    scope: "http.users.write",
    identity: "203.0.113.10",
  });
  expect(consume).toHaveBeenNthCalledWith(3, {
    scope: "http.users.write",
    identity: "203.0.113.10",
  });
  expect(consume).toHaveBeenNthCalledWith(4, {
    scope: "http.users.read",
    identity: "203.0.113.10",
  });
  expect(consume).toHaveBeenNthCalledWith(5, {
    scope: "http.users.read",
    identity: "203.0.113.10",
  });
  expect(JSON.stringify(consume.mock.calls)).not.toContain(userId);
});

test("rate limit denial returns quota fields, the correlated common 429 envelope, and Retry-After", async () => {
  const consume = mock(
    async () =>
      ({
        allowed: false,
        retryAfterSeconds: 3,
        quota: {
          policyId: "http.global",
          limit: 120,
          remaining: 0,
          windowSeconds: 60,
          resetAfterSeconds: 3,
        },
      }) as const,
  );
  const app = buildApp({ consume }, "198.51.100.20");
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

  const response = await app.request("/openapi.json", {
    headers: {
      "x-request-id": requestId,
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    },
  });

  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3");
  expect(response.headers.get("ratelimit-policy")).toBe('"http.global";q=120;w=60');
  expect(response.headers.get("ratelimit")).toBe('"http.global";r=0;t=3');
  expect(await response.json()).toEqual({
    error: { code: "RATE_LIMITED", message: "Too many requests" },
    requestId,
    traceId,
  });
});

test("health endpoints bypass application rate limiting", async () => {
  const consume = mock(async () => ({ allowed: false, retryAfterSeconds: 60 }) as const);
  const app = buildApp({ consume }, "203.0.113.10");

  for (const path of ["/health", "/health/live", "/health/ready"]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
  }

  expect(consume).not.toHaveBeenCalled();
});

test("missing network identity skips rate limiting for in-process and non-network adapters", async () => {
  const consume = mock(async () => ({ allowed: false, retryAfterSeconds: 60 }) as const);
  const app = buildApp({ consume });

  const response = await app.request("/openapi.json");

  expect(response.status).toBe(200);
  expect(consume).not.toHaveBeenCalled();
});

test("adapters without quota metadata remain compatible and emit no draft RateLimit fields", async () => {
  const consume = mock(async () => ({ allowed: true }) as const);
  const app = buildApp({ consume }, "203.0.113.10");

  const response = await app.request("/openapi.json");

  expect(response.status).toBe(200);
  expect(response.headers.get("ratelimit-policy")).toBeNull();
  expect(response.headers.get("ratelimit")).toBeNull();
});

test("invalid quota metadata becomes a correlated internal error without emitting unsafe headers", async () => {
  const consume = mock(
    async () =>
      ({
        allowed: true,
        quota: {
          policyId: 'http.global"\r\nx-injected: yes',
          limit: 120,
          remaining: 119,
          windowSeconds: 60,
          resetAfterSeconds: 30,
        },
      }) as const,
  );
  const app = buildApp({ consume }, "203.0.113.10");

  const response = await app.request("/openapi.json");

  expect(response.status).toBe(500);
  expect(response.headers.get("x-injected")).toBeNull();
  expect(response.headers.get("ratelimit")).toBeNull();
  expect(await response.json()).toMatchObject({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
});

test("invalid limiter retry metadata becomes a correlated internal error", async () => {
  const consume = mock(async () => ({ allowed: false, retryAfterSeconds: Number.NaN }) as const);
  const app = buildApp({ consume }, "203.0.113.10");

  const response = await app.request("/openapi.json");

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
});
