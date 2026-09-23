import { expect, mock, test } from "bun:test";
import { createApp } from "../../src/app/app";
import type { PrincipalResolver } from "../../src/core/auth/principal-resolver";
import { ReadinessChecker } from "../../src/core/health/readiness-checker";
import type { TransactionManager } from "../../src/core/transaction/transaction-manager";
import { Sha256StringDigester } from "../../src/infrastructure/crypto/sha256-string-digester";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../src/modules/users/application/create-user.service";
import { DeleteUserService } from "../../src/modules/users/application/delete-user.service";
import { GetUserService } from "../../src/modules/users/application/get-user.service";
import { ListUsersService } from "../../src/modules/users/application/list-users.service";
import { UpdateUserService } from "../../src/modules/users/application/update-user.service";
import type { UserCreationIdempotencyRepository } from "../../src/modules/users/application/user-creation-idempotency.repository";
import type { UserUnitOfWork } from "../../src/modules/users/application/user-unit-of-work";
import type { User } from "../../src/modules/users/domain/user";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";
import { userUnitOfWork } from "../helpers/user-unit-of-work";

function transactions(
  repository: UserRepository,
  idempotency?: UserCreationIdempotencyRepository,
): TransactionManager<UserUnitOfWork> {
  return {
    run: async (operation) => operation(userUnitOfWork(repository, idempotency)),
  };
}

function principalResolver(
  tenantId: string,
  scopes: readonly string[],
  subject = "user-123",
): PrincipalResolver {
  return { resolve: mock(async () => ({ subject, tenantId, scopes })) };
}

function buildApp(resolver?: PrincipalResolver, maxRequestBodyBytes?: number) {
  const user = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-a",
    email: "lamy@example.com",
    name: "Lamy",
    version: 1,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
  };
  const findById = mock(async (tenantId: string) => (tenantId === user.tenantId ? user : null));
  const findByEmail = mock(async (_tenantId: string, _email: string) => null);
  const listPage = mock(
    async (tenantId: string, input: { readonly offset: number; readonly limit: number }) => ({
      users: tenantId === user.tenantId && input.offset === 0 ? [user] : [],
      total: tenantId === user.tenantId ? 1 : 0,
    }),
  );
  const update = mock(
    async (
      tenantId: string,
      id: string,
      fields: { readonly email?: string; readonly name?: string },
      precondition:
        | { readonly kind: "any-current" }
        | { readonly kind: "versions"; readonly versions: readonly number[] },
    ) => {
      if (tenantId !== user.tenantId || id !== user.id) {
        return { state: "not_found" as const };
      }
      if (
        precondition.kind === "versions" &&
        !precondition.versions.includes(user.version)
      ) {
        return { state: "precondition_failed" as const };
      }
      return {
        state: "updated" as const,
        user: { ...user, ...fields, version: user.version + 1 },
      };
    },
  );
  const deleteById = mock(async (tenantId: string, id: string) =>
    tenantId === user.tenantId && id === user.id
  );
  const create = mock(async (input: { tenantId: string; email: string; name: string }) => ({
    ...user,
    ...input,
  }));
  const repository: UserRepository = { findById, findByEmail, create };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  return {
    app: createApp(
      {
        logger,
        readinessChecker: new ReadinessChecker([]),
        createUserService: new CreateUserService(
          transactions(repository),
          logger,
          new Sha256StringDigester(),
        ),
        deleteUserService: new DeleteUserService({ deleteById }, logger),
        getUserService: new GetUserService(repository),
        listUsersService: new ListUsersService({ listPage }),
        updateUserService: new UpdateUserService({ update }, logger),
        ...(resolver === undefined ? {} : { principalResolver: resolver }),
      },
      maxRequestBodyBytes === undefined ? undefined : { maxRequestBodyBytes },
    ),
    repository,
    findById,
    findByEmail,
    listPage,
    update,
    deleteById,
    create,
  };
}

function createIdempotencyHarness() {
  const usersById = new Map<string, User>();
  const userIdByTenantEmail = new Map<string, string>();
  const ledger = new Map<string, { requestFingerprint: string; userId: string | null }>();

  const findById = mock(async (tenantId: string, id: string) => {
    const user = usersById.get(id);
    return user?.tenantId === tenantId ? user : null;
  });
  const findByEmail = mock(async (tenantId: string, email: string) => {
    const id = userIdByTenantEmail.get(`${tenantId}\n${email}`);
    return id ? (usersById.get(id) ?? null) : null;
  });
  const create = mock(async (input: { tenantId: string; email: string; name: string }) => {
    const user: User = {
      id: crypto.randomUUID(),
      ...input,
      version: 1,
      createdAt: new Date("2026-09-18T00:00:00.000Z"),
    };
    usersById.set(user.id, user);
    userIdByTenantEmail.set(`${input.tenantId}\n${input.email}`, user.id);
    return user;
  });
  const repository: UserRepository = { findById, findByEmail, create };
  const listPage = mock(
    async (tenantId: string, input: { readonly offset: number; readonly limit: number }) => {
      const tenantUsers = [...usersById.values()]
        .filter((user) => user.tenantId === tenantId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      return {
        users: tenantUsers.slice(input.offset, input.offset + input.limit),
        total: tenantUsers.length,
      };
    },
  );

  const claim = mock(async (input: {
    tenantId: string;
    keyHash: string;
    requestFingerprint: string;
    ttlSeconds: number;
  }) => {
    const key = `${input.tenantId}\n${input.keyHash}`;
    const existing = ledger.get(key);
    if (existing) {
      return { state: "existing" as const, record: existing };
    }
    ledger.set(key, { requestFingerprint: input.requestFingerprint, userId: null });
    return { state: "claimed" as const };
  });
  const complete = mock(async (input: {
    tenantId: string;
    keyHash: string;
    requestFingerprint: string;
    userId: string;
  }) => {
    ledger.set(`${input.tenantId}\n${input.keyHash}`, {
      requestFingerprint: input.requestFingerprint,
      userId: input.userId,
    });
  });
  const idempotencyRepository: UserCreationIdempotencyRepository = { claim, complete };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  const service = new CreateUserService(
    transactions(repository, idempotencyRepository),
    logger,
    new Sha256StringDigester(),
  );

  const appForTenant = (tenantId: string) =>
    createApp({
      logger,
      readinessChecker: new ReadinessChecker([]),
      createUserService: service,
      deleteUserService: new DeleteUserService({ deleteById: mock(async () => false) }, logger),
      getUserService: new GetUserService(repository),
      listUsersService: new ListUsersService({ listPage }),
      updateUserService: new UpdateUserService(
        { update: mock(async () => ({ state: "not_found" as const })) },
        logger,
      ),
      principalResolver: principalResolver(tenantId, ["users:read", "users:write"]),
    });

  return { appForTenant, repository, claim, complete, ledger };
}

test("invalid request body returns the common validation error schema before authorization", async () => {
  const { app } = buildApp();
  const response = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", name: "Lamy" }),
  });

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(typeof body.requestId).toBe("string");
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
});

test("oversized request body returns a correlated common 413 before service work", async () => {
  const { app, repository } = buildApp(undefined, 128);
  const requestId = "550e8400-e29b-41d4-a716-446655440000";
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const request = new Request("http://localhost/users", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      traceparent: `00-${traceId}-00f067aa0ba902b7-01`,
    },
    body: JSON.stringify({ email: "lamy@example.com", name: "L".repeat(100) }),
  });

  expect(request.headers.get("content-length")).toBeNull();
  const response = await app.fetch(request);

  expect(response.status).toBe(413);
  const body = await response.json();
  expect(body).toMatchObject({
    error: {
      code: "REQUEST_BODY_TOO_LARGE",
      message: "Request body is too large",
      details: { maxBytes: 128 },
    },
    requestId,
    traceId,
  });
  expect(repository.findByEmail).not.toHaveBeenCalled();
  expect(repository.create).not.toHaveBeenCalled();
});

test("anonymous protected user requests return 401", async () => {
  const { app, repository } = buildApp();
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000");

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  expect(repository.findById).not.toHaveBeenCalled();
});

test("authenticated requests missing the required scope return 403", async () => {
  const { app, repository } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users/550e8400-e29b-41d4-A716-446655440000");

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(repository.findById).not.toHaveBeenCalled();
});

test("uppercase UUID path input is accepted and normalized after tenant authorization", async () => {
  const { app, repository } = buildApp(principalResolver("tenant-a", ["users:read"]));
  const response = await app.request("/users/550E8400-E29B-41D4-A716-446655440000");

  expect(response.status).toBe(200);
  expect(repository.findById).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
  );
  const body = await response.json();
  expect(body.id).toBe("550e8400-e29b-41d4-a716-446655440000");
  expect(body.tenantId).toBeUndefined();
  expect(response.headers.get("etag")).toBe('"v1"');
});

test("authorized user listing applies pagination defaults and hides tenant metadata", async () => {
  const { app, listPage } = buildApp(principalResolver("tenant-a", ["users:read"]));

  const response = await app.request("/users");

  expect(response.status).toBe(200);
  expect(listPage).toHaveBeenCalledWith("tenant-a", { offset: 0, limit: 20 });
  expect(await response.json()).toEqual({
    data: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: "lamy@example.com",
        name: "Lamy",
        createdAt: "2026-09-13T00:00:00.000Z",
      },
    ],
    meta: { page: 1, perPage: 20, total: 1, totalPages: 1 },
  });
});

test("user listing coerces bounded query pagination and derives the repository offset", async () => {
  const { app, listPage } = buildApp(principalResolver("tenant-a", ["users:read"]));

  const response = await app.request("/users?page=2&perPage=1");

  expect(response.status).toBe(200);
  expect(listPage).toHaveBeenCalledWith("tenant-a", { offset: 1, limit: 1 });
  expect(await response.json()).toEqual({
    data: [],
    meta: { page: 2, perPage: 1, total: 1, totalPages: 1 },
  });
});

test("excessively deep user pages fail validation before repository work", async () => {
  const { app, listPage } = buildApp(principalResolver("tenant-a", ["users:read"]));

  const response = await app.request("/users?page=10001");

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(listPage).not.toHaveBeenCalled();
});

test("user listing derives tenant scope only from the authorized principal", async () => {
  const { app, listPage } = buildApp(principalResolver("tenant-b", ["users:read"]));

  const response = await app.request("/users");

  expect(response.status).toBe(200);
  expect(listPage).toHaveBeenCalledWith("tenant-b", { offset: 0, limit: 20 });
  expect(await response.json()).toEqual({
    data: [],
    meta: { page: 1, perPage: 20, total: 0, totalPages: 0 },
  });
});

test("authorized PATCH updates only the principal tenant with normalized fields", async () => {
  const { app, update } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users/550E8400-E29B-41D4-A716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"v1"' },
    body: JSON.stringify({
      email: "UPDATED@Example.com",
      name: " Updated ",
      tenantId: "tenant-b",
    }),
  });

  expect(response.status).toBe(200);
  expect(update).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
    { email: "updated@example.com", name: "Updated" },
    { kind: "versions", versions: [1] },
  );
  expect(response.headers.get("etag")).toBe('"v2"');
  expect(await response.json()).toEqual({
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: "updated@example.com",
    name: "Updated",
    createdAt: "2026-09-13T00:00:00.000Z",
  });
});

test("anonymous PATCH remains 401 even when If-Match is omitted", async () => {
  const { app, update } = buildApp();
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Updated" }),
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    error: { code: "UNAUTHORIZED" },
  });
  expect(update).not.toHaveBeenCalled();
});

test("weak If-Match never satisfies the strong user validator", async () => {
  const { app, update } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": 'W/"v1"' },
    body: JSON.stringify({ name: "Weak" }),
  });

  expect(response.status).toBe(412);
  expect(update).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
    { name: "Weak" },
    { kind: "versions", versions: [] },
  );
});

test("PATCH requires If-Match to prevent lost updates", async () => {
  const { app, update } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Updated" }),
  });

  expect(response.status).toBe(428);
  expect(await response.json()).toMatchObject({
    error: { code: "PRECONDITION_REQUIRED" },
  });
  expect(update).not.toHaveBeenCalled();
});

test("stale If-Match returns 412 without updating the user", async () => {
  const { app, update } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"v99"' },
    body: JSON.stringify({ name: "Stale" }),
  });

  expect(response.status).toBe(412);
  expect(await response.json()).toMatchObject({
    error: { code: "PRECONDITION_FAILED" },
  });
  expect(update).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
    { name: "Stale" },
    { kind: "versions", versions: [99] },
  );
});

test("empty PATCH is rejected before repository work", async () => {
  const { app, update } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(update).not.toHaveBeenCalled();
});

test("PATCH requires users:write before repository work", async () => {
  const { app, update } = buildApp(principalResolver("tenant-a", ["users:read"]));
  const response = await app.request("/users/550e8400-e29b-41D4-A716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"v1"' },
    body: JSON.stringify({ name: "Updated" }),
  });

  expect(response.status).toBe(403);
  expect(update).not.toHaveBeenCalled();
});

test("cross-tenant PATCH is indistinguishable from a missing user", async () => {
  const { app, update } = buildApp(principalResolver("tenant-b", ["users:write"]));
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"v1"' },
    body: JSON.stringify({ name: "Updated" }),
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(update).toHaveBeenCalledWith(
    "tenant-b",
    "550e8400-e29b-41d4-a716-446655440000",
    { name: "Updated" },
    { kind: "versions", versions: [1] },
  );
});

test("authorized DELETE removes only the principal tenant user and returns 204", async () => {
  const { app, deleteById } = buildApp(principalResolver("tenant-a", ["users:write"]));

  const response = await app.request("/users/550E8400-E29B-41D4-A716-446655440000", {
    method: "DELETE",
  });

  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(deleteById).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
  );
});

test("DELETE requires users:write before repository work", async () => {
  const { app, deleteById } = buildApp(principalResolver("tenant-a", ["users:read"]));

  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "DELETE",
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(deleteById).not.toHaveBeenCalled();
});

test("cross-tenant DELETE is indistinguishable from a missing user", async () => {
  const { app, deleteById } = buildApp(principalResolver("tenant-b", ["users:write"]));

  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000", {
    method: "DELETE",
  });

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(deleteById).toHaveBeenCalledWith(
    "tenant-b",
    "550e8400-e29b-41d4-a716-446655440000",
  );
});

test("cross-tenant GET is indistinguishable from a missing user", async () => {
  const { app, repository } = buildApp(principalResolver("tenant-b", ["users:read"]));
  const response = await app.request("/users/550e8400-e29b-41d4-a716-446655440000");

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(repository.findById).toHaveBeenCalledWith(
    "tenant-b",
    "550e8400-e29b-41d4-a716-446655440000",
  );
});

test("authorized create derives tenant from principal and ignores client tenant fields", async () => {
  const { app, repository } = buildApp(principalResolver("tenant-a", ["users:write"]));
  const response = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: "tenant-attacker",
      email: "new@example.com",
      name: " New User ",
    }),
  });

  expect(response.status).toBe(201);
  expect(response.headers.get("etag")).toBe('"v1"');
  expect(repository.findByEmail).toHaveBeenCalledWith("tenant-a", "new@example.com");
  expect(repository.create).toHaveBeenCalledWith({
    tenantId: "tenant-a",
    email: "new@example.com",
    name: "New User",
  });
  const body = await response.json();
  expect(body.tenantId).toBeUndefined();
});

test("omitting Idempotency-Key preserves normal create behavior", async () => {
  const { appForTenant, claim } = createIdempotencyHarness();
  const response = await appForTenant("tenant-a").request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "normal@example.com", name: "Normal" }),
  });

  expect(response.status).toBe(201);
  expect(claim).not.toHaveBeenCalled();
});

test("invalid Idempotency-Key is rejected with 400 without echoing the key", async () => {
  const rawKey = "contains a space";
  const { appForTenant, claim } = createIdempotencyHarness();
  const response = await appForTenant("tenant-a").request("/users", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": rawKey,
    },
    body: JSON.stringify({ email: "invalid-key@example.com", name: "Invalid" }),
  });

  expect(response.status).toBe(400);
  const body = JSON.stringify(await response.json());
  expect(body).not.toContain(rawKey);
  expect(claim).not.toHaveBeenCalled();
});

test("same Idempotency-Key and normalized payload replay 201 with the same user ID", async () => {
  const key = "550e8400-e29b-41d4-a716-446655440000";
  const { appForTenant, claim, complete } = createIdempotencyHarness();
  const app = appForTenant("tenant-a");

  const first = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ email: "Replay@Example.com", name: " Replay User " }),
  });
  const second = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ email: "replay@example.com", name: "Replay User" }),
  });

  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const firstBody = await first.json();
  const secondBody = await second.json();
  expect(secondBody.id).toBe(firstBody.id);
  expect(claim).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenCalledTimes(1);
});

test("same Idempotency-Key with a different normalized payload returns sanitized 422", async () => {
  const key = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const { appForTenant } = createIdempotencyHarness();
  const app = appForTenant("tenant-a");

  const first = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ email: "mismatch@example.com", name: "First" }),
  });
  expect(first.status).toBe(201);

  const second = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ email: "mismatch@example.com", name: "Second" }),
  });

  expect(second.status).toBe(422);
  const body = await second.json();
  expect(body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
  expect(JSON.stringify(body)).not.toContain(key);
});

test("the same raw Idempotency-Key is independent across tenant principals", async () => {
  const key = "9b2de3f4-0d7d-4f09-8901-16d6d24af275";
  const { appForTenant, repository } = createIdempotencyHarness();

  const tenantA = await appForTenant("tenant-a").request("/users", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ tenantId: "tenant-attacker", email: "same@example.com", name: "A" }),
  });
  const tenantB = await appForTenant("tenant-b").request("/users", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ tenantId: "tenant-attacker", email: "same@example.com", name: "B" }),
  });

  expect(tenantA.status).toBe(201);
  expect(tenantB.status).toBe(201);
  expect(repository.create).toHaveBeenCalledWith({
    tenantId: "tenant-a",
    email: "same@example.com",
    name: "A",
  });
  expect(repository.create).toHaveBeenCalledWith({
    tenantId: "tenant-b",
    email: "same@example.com",
    name: "B",
  });
});

test("valid incoming traceparent keeps the trace ID and emits a new span ID", async () => {
  const { app } = buildApp();
  const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const response = await app.request("/health", { headers: { traceparent: incoming } });

  expect(response.status).toBe(200);
  const outgoing = response.headers.get("traceparent");
  expect(outgoing).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  expect(outgoing).not.toBe(incoming);
});

test("createApp wires authorization and cookie credentials into PrincipalResolver", async () => {
  const resolve = mock(async () => ({ subject: "user-123" }));
  const { app } = buildApp({ resolve });

  const response = await app.request("/health", {
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
});
