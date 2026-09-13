import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createUserFactory } from "../../../factories/user.factory";
import { createTestDatabase } from "../../../helpers/database";
import { users } from "../../../../src/db/schema";
import { DrizzleUserRepository } from "../../../../src/modules/users/infrastructure/drizzle-user.repository";

const database = createTestDatabase();
const repository = new DrizzleUserRepository(database.db);

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
  const seeded = await createUserFactory(database.db, { email: "seed@example.com" });

  const found = await repository.findById(seeded.id);

  expect(found).not.toBeNull();
  expect(found?.email).toBe("seed@example.com");
});
