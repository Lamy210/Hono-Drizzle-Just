import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { userCreationIdempotency, users } from "../../../src/db/schema";
import { DrizzleTransactionManager } from "../../../src/infrastructure/database/drizzle-transaction-manager";
import type { UserUnitOfWork } from "../../../src/modules/users/application/user-unit-of-work";
import { DrizzleUserCreationIdempotencyRepository } from "../../../src/modules/users/infrastructure/drizzle-user-creation-idempotency.repository";
import { DrizzleUserRepository } from "../../../src/modules/users/infrastructure/drizzle-user.repository";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const transactions = new DrizzleTransactionManager<UserUnitOfWork>(database.db, (session) => ({
  users: new DrizzleUserRepository(session),
  userCreationIdempotency: new DrizzleUserCreationIdempotencyRepository(session),
}));

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

test("commits tenant-scoped repository writes when the unit of work succeeds", async () => {
  const email = `commit-${crypto.randomUUID()}@example.com`;

  const created = await transactions.run((unitOfWork) =>
    unitOfWork.users.create({ tenantId: "tenant-transaction", email, name: "Commit" }),
  );

  const [persisted] = await database.db.select().from(users).where(eq(users.id, created.id));
  expect(persisted?.tenantId).toBe("tenant-transaction");
  expect(persisted?.email).toBe(email);
});

test("rolls back earlier tenant-scoped repository writes when a later write fails", async () => {
  const email = `rollback-${crypto.randomUUID()}@example.com`;

  await expect(
    transactions.run(async (unitOfWork) => {
      await unitOfWork.users.create({ tenantId: "tenant-transaction", email, name: "First" });
      await unitOfWork.users.create({ tenantId: "tenant-transaction", email, name: "Duplicate" });
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

  const persisted = await database.db.select().from(users).where(eq(users.email, email));
  expect(persisted).toHaveLength(0);
});

test("replays the complete database transaction only when marked retry-safe", async () => {
  const email = `retry-${crypto.randomUUID()}@example.com`;
  let attempts = 0;

  const created = await transactions.run(
    async (unitOfWork) => {
      attempts += 1;
      const user = await unitOfWork.users.create({
        tenantId: "tenant-retry",
        email,
        name: `Attempt ${attempts}`,
      });

      if (attempts === 1) {
        throw Object.assign(new Error("serialization failure"), { code: "40001" });
      }
      return user;
    },
    { retry: "safe" },
  );

  expect(attempts).toBe(2);
  expect(created.name).toBe("Attempt 2");

  const persisted = await database.db.select().from(users).where(eq(users.email, email));
  expect(persisted).toHaveLength(1);
  expect(persisted[0]?.name).toBe("Attempt 2");
});

