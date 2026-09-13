import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { users } from "../../../../src/db/schema";
import { DrizzleUserRepository } from "../../../../src/modules/users/infrastructure/drizzle-user.repository";
import { makeUserFactory } from "../../../factories/user.factory";
import { createTestDatabase } from "../../../helpers/database";

const database = createTestDatabase();
const repository = new DrizzleUserRepository(database.db);
const userFactory = makeUserFactory(database.db);

beforeAll(async () => {
  await database.pool.query("select 1");
});

beforeEach(async () => {
  await database.db.delete(users);
});

afterAll(async () => {
  await database.close();
});

test("repository reads rows created by the database factory", async () => {
  const seeded = await userFactory.create({ email: "seed@example.com" });

  const found = await repository.findById(seeded.id);

  expect(found).not.toBeNull();
  expect(found?.email).toBe("seed@example.com");
});

test("repository maps a wrapped PostgreSQL unique violation to a conflict AppError", async () => {
  const email = `duplicate-${crypto.randomUUID()}@example.com`;
  await repository.create({ email, name: "First" });

  await expect(repository.create({ email, name: "Duplicate" })).rejects.toMatchObject({
    code: "CONFLICT",
    status: 409,
  });
});
