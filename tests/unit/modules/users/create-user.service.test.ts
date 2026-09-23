import { expect, mock, spyOn, test } from "bun:test";
import type { StringDigester } from "../../../../src/core/crypto/string-digester";
import type { RequestContext } from "../../../../src/core/context/request-context";
import type { TransactionManager } from "../../../../src/core/transaction/transaction-manager";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../../../src/modules/users/application/create-user.service";
import type { UserCreationIdempotencyRepository } from "../../../../src/modules/users/application/user-creation-idempotency.repository";
import type { UserUnitOfWork } from "../../../../src/modules/users/application/user-unit-of-work";
import type { CreateUserInput, User } from "../../../../src/modules/users/domain/user";
import type { UserRepository } from "../../../../src/modules/users/domain/user.repository";
import { userUnitOfWork } from "../../../helpers/user-unit-of-work";

const context: RequestContext = {
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  },
  startedAt: 0,
  principal: {
    subject: "user-123",
    tenantId: "tenant-a",
    scopes: ["users:read", "users:write"],
  },
};

type IdempotentCreateUserService = {
  execute(
    input: CreateUserInput,
    context: RequestContext,
    options?: { readonly idempotencyKey?: string },
  ): Promise<User>;
};

type IdempotentCreateUserServiceConstructor = new (
  transactions: TransactionManager<UserUnitOfWork>,
  logger: JsonConsoleLogger,
  digester: StringDigester,
) => IdempotentCreateUserService;

function transactionManager(
  repository: UserRepository,
  idempotency?: UserCreationIdempotencyRepository,
): TransactionManager<UserUnitOfWork> {
  return {
    run: mock(async (operation, _options) =>
      operation(userUnitOfWork(repository, idempotency)),
    ),
  };
}

function createService(
  transactions: TransactionManager<UserUnitOfWork>,
  logger: JsonConsoleLogger,
  digester: StringDigester,
): IdempotentCreateUserService {
  const Constructor = CreateUserService as unknown as IdempotentCreateUserServiceConstructor;
  return new Constructor(transactions, logger, digester);
}

function digesterFor(rawKey: string, canonical: string) {
  const keyHash = "a".repeat(64);
  const requestFingerprint = "b".repeat(64);
  const sha256Hex = mock((value: string) => {
    if (value === rawKey) return keyHash;
    if (value === canonical) return requestFingerprint;
    return "c".repeat(64);
  });
  const digester: StringDigester = { sha256Hex };
  return { digester, sha256Hex, keyHash, requestFingerprint };
}

function noDigest(): StringDigester {
  return {
    sha256Hex: mock(() => {
      throw new Error("unexpected digest");
    }),
  };
}

function deniedRepository() {
  const findById = mock(async () => null);
  const findByEmail = mock(async () => null);
  const create = mock(async (input: { email: string; name: string; tenantId?: string }) => ({
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: input.tenantId ?? "tenant-a",
    email: input.email,
    name: input.name,
    version: 1,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
  }));
  const repository: UserRepository = { findById, findByEmail, create };
  return { repository, findById, findByEmail, create };
}

function testUser(overrides: Partial<User> = {}): User {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-a",
    email: "lamy@example.com",
    name: "Lamy",
    version: 1,
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
    ...overrides,
  };
}

test("no-key path preserves existing transaction behavior without touching idempotency", async () => {
  const createdAt = new Date("2026-09-13T00:00:00.000Z");
  const findByEmail = mock(async () => null);
  const create = mock(async (input: { email: string; name: string; tenantId?: string }) => ({
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: input.tenantId ?? "tenant-a",
    email: input.email,
    name: input.name,
    version: 1,
    createdAt,
  }));
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail,
    create,
  };
  const claim = mock(async () => ({ state: "claimed" as const }));
  const complete = mock(async () => undefined);
  const transactions = transactionManager(repository, { claim, complete });
  const logger = new JsonConsoleLogger({}, () => undefined);
  const infoSpy = spyOn(logger, "info");
  const digester = noDigest();
  const service = createService(transactions, logger, digester);

  const user = await service.execute({ email: " LAMY@example.com ", name: " Lamy " }, context);

  expect(transactions.run).toHaveBeenCalledTimes(1);
  expect(transactions.run).toHaveBeenCalledWith(expect.any(Function), { retry: "safe" });
  expect(findByEmail).toHaveBeenCalledWith("tenant-a", "lamy@example.com");
  expect(create).toHaveBeenCalledWith({
    tenantId: "tenant-a",
    email: "lamy@example.com",
    name: "Lamy",
  });
  expect(claim).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(digester.sha256Hex).not.toHaveBeenCalled();
  expect(user.email).toBe("lamy@example.com");
  expect(infoSpy).toHaveBeenCalledTimes(1);
});

test("fresh idempotency claim hashes canonical input, creates once, and completes the claim", async () => {
  const rawKey = "Request-Key-123";
  const canonical = "users:create:v1\nlamy@example.com\nLamy";
  const { digester, sha256Hex, keyHash, requestFingerprint } = digesterFor(rawKey, canonical);
  const user = testUser();
  const findByEmail = mock(async () => null);
  const create = mock(async () => user);
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail,
    create,
  };
  const claim = mock(async () => ({ state: "claimed" as const }));
  const complete = mock(async () => undefined);
  const logger = new JsonConsoleLogger({}, () => undefined);
  const infoSpy = spyOn(logger, "info");
  const transactions = transactionManager(repository, { claim, complete });
  const service = createService(transactions, logger, digester);

  const result = await service.execute(
    { email: " LAMY@example.com ", name: " Lamy " },
    context,
    { idempotencyKey: rawKey },
  );

  expect(sha256Hex).toHaveBeenCalledWith(rawKey);
  expect(sha256Hex).toHaveBeenCalledWith(canonical);
  expect(transactions.run).toHaveBeenCalledTimes(1);
  expect(transactions.run).toHaveBeenCalledWith(expect.any(Function), { retry: "safe" });
  expect(claim).toHaveBeenCalledWith({
    tenantId: "tenant-a",
    keyHash,
    requestFingerprint,
    ttlSeconds: 86_400,
  });
  expect(findByEmail).toHaveBeenCalledWith("tenant-a", "lamy@example.com");
  expect(create).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledWith({
    tenantId: "tenant-a",
    keyHash,
    requestFingerprint,
    userId: user.id,
  });
  expect(result).toEqual(user);
  expect(infoSpy).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(rawKey);
  expect(JSON.stringify(claim.mock.calls)).not.toContain(rawKey);
});

test("same fingerprint replays the tenant-scoped user without a second create or business log", async () => {
  const rawKey = "Replay-Key-123";
  const canonical = "users:create:v1\nlamy@example.com\nLamy";
  const { digester, requestFingerprint } = digesterFor(rawKey, canonical);
  const user = testUser();
  const findById = mock(async (tenantId: string, id: string) =>
    tenantId === "tenant-a" && id === user.id ? user : null,
  );
  const create = mock(async () => user);
  const repository: UserRepository = {
    findById,
    findByEmail: mock(async () => null),
    create,
  };
  const claim = mock(async () => ({
    state: "existing" as const,
    record: { requestFingerprint, userId: user.id },
  }));
  const complete = mock(async () => undefined);
  const logger = new JsonConsoleLogger({}, () => undefined);
  const infoSpy = spyOn(logger, "info");
  const service = createService(transactionManager(repository, { claim, complete }), logger, digester);

  const result = await service.execute(
    { email: "lamy@example.com", name: "Lamy" },
    context,
    { idempotencyKey: rawKey },
  );

  expect(result).toEqual(user);
  expect(findById).toHaveBeenCalledWith("tenant-a", user.id);
  expect(repository.findByEmail).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(infoSpy).not.toHaveBeenCalled();
});

test("same key with a different fingerprint returns a sanitized 422", async () => {
  const rawKey = "Mismatch-Key-123";
  const canonical = "users:create:v1\nlamy@example.com\nLamy";
  const { digester, requestFingerprint } = digesterFor(rawKey, canonical);
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => null),
    create: mock(async () => testUser()),
  };
  const claim = mock(async () => ({
    state: "existing" as const,
    record: { requestFingerprint: "d".repeat(64), userId: testUser().id },
  }));
  const service = createService(
    transactionManager(repository, { claim, complete: mock(async () => undefined) }),
    new JsonConsoleLogger({}, () => undefined),
    digester,
  );

  try {
    await service.execute(
      { email: "lamy@example.com", name: "Lamy" },
      context,
      { idempotencyKey: rawKey },
    );
    throw new Error("expected mismatch to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 422 });
    const serialized = String(error);
    expect(serialized).not.toContain(rawKey);
    expect(serialized).not.toContain(requestFingerprint);
    expect(serialized).not.toContain("lamy@example.com");
  }
  expect(repository.findById).not.toHaveBeenCalled();
  expect(repository.create).not.toHaveBeenCalled();
});

test("committed idempotency records with no user pointer fail closed", async () => {
  const rawKey = "Incomplete-Key-123";
  const canonical = "users:create:v1\nlamy@example.com\nLamy";
  const { digester, requestFingerprint } = digesterFor(rawKey, canonical);
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => null),
    create: mock(async () => testUser()),
  };
  const claim = mock(async () => ({
    state: "existing" as const,
    record: { requestFingerprint, userId: null },
  }));
  const service = createService(
    transactionManager(repository, { claim, complete: mock(async () => undefined) }),
    new JsonConsoleLogger({}, () => undefined),
    digester,
  );

  await expect(
    service.execute(
      { email: "lamy@example.com", name: "Lamy" },
      context,
      { idempotencyKey: rawKey },
    ),
  ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
  expect(repository.findById).not.toHaveBeenCalled();
});

test("replay fails closed when the referenced user is absent from the authorized tenant", async () => {
  const rawKey = "Missing-User-Key-123";
  const canonical = "users:create:v1\nlamy@example.com\nLamy";
  const { digester, requestFingerprint } = digesterFor(rawKey, canonical);
  const userId = testUser().id;
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => null),
    create: mock(async () => testUser()),
  };
  const claim = mock(async () => ({
    state: "existing" as const,
    record: { requestFingerprint, userId },
  }));
  const service = createService(
    transactionManager(repository, { claim, complete: mock(async () => undefined) }),
    new JsonConsoleLogger({}, () => undefined),
    digester,
  );

  await expect(
    service.execute(
      { email: "lamy@example.com", name: "Lamy" },
      context,
      { idempotencyKey: rawKey },
    ),
  ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
  expect(repository.findById).toHaveBeenCalledWith("tenant-a", userId);
});

test("service rolls out of the unit of work without creating when the tenant-local email exists", async () => {
  const existing = testUser();
  const create = mock(async () => existing);
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => existing),
    create,
  };
  const transactions = transactionManager(repository);
  const service = createService(transactions, new JsonConsoleLogger({}, () => undefined), noDigest());

  await expect(
    service.execute({ email: "lamy@example.com", name: "Lamy" }, context),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  expect(transactions.run).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();
});

test("anonymous requests are rejected before transaction work", async () => {
  const { repository, findByEmail, create } = deniedRepository();
  const transactions = transactionManager(repository);
  const service = createService(transactions, new JsonConsoleLogger({}, () => undefined), noDigest());
  const anonymous: RequestContext = {
    requestId: context.requestId,
    trace: context.trace,
    startedAt: context.startedAt,
  };

  await expect(
    service.execute({ email: "lamy@example.com", name: "Lamy" }, anonymous),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  expect(transactions.run).not.toHaveBeenCalled();
  expect(findByEmail).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

test("authenticated requests without a tenant are forbidden before transaction work", async () => {
  const { repository } = deniedRepository();
  const transactions = transactionManager(repository);
  const service = createService(transactions, new JsonConsoleLogger({}, () => undefined), noDigest());
  const missingTenant: RequestContext = {
    ...context,
    principal: { subject: "user-123", scopes: ["users:write"] },
  };

  await expect(
    service.execute({ email: "lamy@example.com", name: "Lamy" }, missingTenant),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(transactions.run).not.toHaveBeenCalled();
});

test("reserved tenant identities are forbidden before transaction work", async () => {
  const { repository } = deniedRepository();
  const transactions = transactionManager(repository);
  const service = createService(transactions, new JsonConsoleLogger({}, () => undefined), noDigest());
  const reservedTenant: RequestContext = {
    ...context,
    principal: {
      subject: "user-123",
      tenantId: "__legacy__:550e8400-e29b-41d4-a716-446655440000",
      scopes: ["users:write"],
    },
  };

  await expect(
    service.execute({ email: "lamy@example.com", name: "Lamy" }, reservedTenant),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(transactions.run).not.toHaveBeenCalled();
});

test("authenticated requests without users:write are forbidden before transaction work", async () => {
  const { repository } = deniedRepository();
  const transactions = transactionManager(repository);
  const service = createService(transactions, new JsonConsoleLogger({}, () => undefined), noDigest());
  const missingScope: RequestContext = {
    ...context,
    principal: {
      subject: "user-123",
      tenantId: "tenant-a",
      scopes: ["users:read"],
    },
  };

  await expect(
    service.execute({ email: "lamy@example.com", name: "Lamy" }, missingScope),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(transactions.run).not.toHaveBeenCalled();
});
