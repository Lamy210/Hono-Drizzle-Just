import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "../../../src/core/context/request-context";
import { userCreationIdempotency, users } from "../../../src/db/schema";
import { Sha256StringDigester } from "../../../src/infrastructure/crypto/sha256-string-digester";
import { DrizzleTransactionManager } from "../../../src/infrastructure/database/drizzle-transaction-manager";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../../src/modules/users/application/create-user.service";
import type { UserUnitOfWork } from "../../../src/modules/users/application/user-unit-of-work";
import { DrizzleUserCreationIdempotencyRepository } from "../../../src/modules/users/infrastructure/drizzle-user-creation-idempotency.repository";
import { DrizzleUserRepository } from "../../../src/modules/users/infrastructure/drizzle-user.repository";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const digester = new Sha256StringDigester();
const transactions = new DrizzleTransactionManager<UserUnitOfWork>(database.db, (session) => ({
  users: new DrizzleUserRepository(session),
  userCreationIdempotency: new DrizzleUserCreationIdempotencyRepository(session),
}));
const logger = new JsonConsoleLogger({ service: "integration-test" }, () => undefined);
const service = new CreateUserService(transactions, logger, digester);

function context(requestId: string): RequestContext {
  return {
    requestId,
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    },
    startedAt: 0,
    principal: {
      subject: "user-123",
      tenantId: "tenant-idempotency-service",
      scopes: ["users:write"],
    },
  };
}

beforeAll(async () => {
  await database.pool.query("select 1");
});

beforeEach(async () => {
  await database.db.delete(userCreationIdempotency);
  await database.db.delete(users);
});

afterAll(async () => {
  await database.close();
});

test("concurrent creates with the same tenant and key create one user and replay the same ID", async () => {
  const key = `create-${crypto.randomUUID()}`;
  const input = {
    email: `concurrent-${crypto.randomUUID()}@example.com`,
    name: "Concurrent User",
  };
  const infoSpy = spyOn(logger, "info");

  const [first, second] = await Promise.all([
    service.execute(input, context(crypto.randomUUID()), { idempotencyKey: key }),
    service.execute(input, context(crypto.randomUUID()), { idempotencyKey: key }),
  ]);

  expect(first.id).toBe(second.id);
  const persistedUsers = await database.db
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, "tenant-idempotency-service"),
        eq(users.email, input.email),
      ),
    );
  expect(persistedUsers).toHaveLength(1);
  expect(persistedUsers[0]?.id).toBe(first.id);

  const ledger = await database.db
    .select()
    .from(userCreationIdempotency)
    .where(
      and(
        eq(userCreationIdempotency.tenantId, "tenant-idempotency-service"),
        eq(userCreationIdempotency.keyHash, digester.sha256Hex(key)),
      ),
    );
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.userId).toBe(first.id);
  expect(infoSpy).toHaveBeenCalledTimes(1);
  infoSpy.mockRestore();
});

test("replay resolves the current tenant-scoped representation after the user changes", async () => {
  const key = `current-${crypto.randomUUID()}`;
  const input = {
    email: `current-${crypto.randomUUID()}@example.com`,
    name: "Original Name",
  };
  const first = await service.execute(input, context(crypto.randomUUID()), {
    idempotencyKey: key,
  });
  expect(first.version).toBe(1);

  const repository = new DrizzleUserRepository(database.db);
  const update = await repository.update(
    "tenant-idempotency-service",
    first.id,
    { name: "Updated Name" },
    { kind: "versions", versions: [1] },
  );
  expect(update).toMatchObject({
    state: "updated",
    user: { id: first.id, name: "Updated Name", version: 2 },
  });

  const infoSpy = spyOn(logger, "info");
  const replay = await service.execute(input, context(crypto.randomUUID()), {
    idempotencyKey: key,
  });

  expect(replay).toMatchObject({
    id: first.id,
    email: input.email,
    name: "Updated Name",
    version: 2,
  });
  expect(infoSpy).not.toHaveBeenCalled();
  infoSpy.mockRestore();

  const persistedUsers = await database.db
    .select()
    .from(users)
    .where(eq(users.id, first.id));
  expect(persistedUsers).toHaveLength(1);
  expect(persistedUsers[0]).toMatchObject({ name: "Updated Name", version: 2 });

  const ledger = await database.db
    .select()
    .from(userCreationIdempotency)
    .where(
      and(
        eq(userCreationIdempotency.tenantId, "tenant-idempotency-service"),
        eq(userCreationIdempotency.keyHash, digester.sha256Hex(key)),
      ),
    );
  expect(ledger).toHaveLength(1);
  expect(ledger[0]?.userId).toBe(first.id);
});

test("a business conflict rolls back its idempotency claim so the key can be reused", async () => {
  const key = `rollback-${crypto.randomUUID()}`;
  const email = `existing-${crypto.randomUUID()}@example.com`;
  const usersRepository = new DrizzleUserRepository(database.db);
  await usersRepository.create({
    tenantId: "tenant-idempotency-service",
    email,
    name: "Existing User",
  });

  await expect(
    service.execute(
      { email, name: "Duplicate User" },
      context(crypto.randomUUID()),
      { idempotencyKey: key },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

  const rolledBackClaim = await database.db
    .select()
    .from(userCreationIdempotency)
    .where(
      and(
        eq(userCreationIdempotency.tenantId, "tenant-idempotency-service"),
        eq(userCreationIdempotency.keyHash, digester.sha256Hex(key)),
      ),
    );
  expect(rolledBackClaim).toHaveLength(0);

  const recovered = await service.execute(
    { email: `recovered-${crypto.randomUUID()}@example.com`, name: "Recovered User" },
    context(crypto.randomUUID()),
    { idempotencyKey: key },
  );
  expect(recovered.tenantId).toBe("tenant-idempotency-service");
});
