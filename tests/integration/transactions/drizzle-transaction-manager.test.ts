import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "../../../src/db/schema";
import { DrizzleTransactionManager } from "../../../src/infrastructure/database/drizzle-transaction-manager";
import { DrizzleUserRepository } from "../../../src/modules/users/infrastructure/drizzle-user.repository";
import type { UserUnitOfWork } from "../../../src/modules/users/application/user-unit-of-work";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const transactions = new DrizzleTransactionManager<UserUnitOfWork>(database.db, (session) => ({
  users: new DrizzleUserRepository(session),
}));

beforeAll(async () => {
  await database.pool.query("select 1");
});

beforeEach(async () => {
  await database.db.delete(users);
});

afterAll(async () => {
  await database.close();
});

test("commits repository writes when the unit of work succeeds", async () => {
  const email = `commit-${crypto.randomUUID()}@example.com`;

  const created = await transactions.run((unitOfWork) =>
    unitOfWork.users.create({ email, name: "Commit" }),
  );

  const [persisted] = await database.db.select().from(users).where(eq(users.id, created.id));
  expect(persisted?.email).toBe(email);
});

test("rolls back earlier repository writes when a later write fails", async () => {
  const email = `rollback-${crypto.randomUUID()}@example.com`;

  await expect(
    transactions.run(async (unitOfWork) => {
      await unitOfWork.users.create({ email, name: "First" });
      await unitOfWork.users.create({ email, name: "Duplicate" });
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

  const persisted = await database.db.select().from(users).where(eq(users.email, email));
  expect(persisted).toHaveLength(0);
});
