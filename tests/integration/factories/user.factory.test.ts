import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { users } from "../../../src/db/schema";
import { DrizzleUserRepository } from "../../../src/modules/users/infrastructure/drizzle-user.repository";
import { makeUserFactory } from "../../factories/user.factory";
import { createTestDatabase } from "../../helpers/database";

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

test("persistent user factory creates valid rows readable through the real repository", async () => {
  const created = await userFactory.createMany(3);

  expect(created).toHaveLength(3);
  expect(new Set(created.map((user) => user.email)).size).toBe(3);
  for (const user of created) {
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await repository.findById(user.id)).toEqual(user);
  }
});

test("user factory supports explicit overrides for deterministic repository tests", async () => {
  const created = await userFactory.create({
    email: "factory@example.com",
    name: "Factory User",
  });

  expect(created.email).toBe("factory@example.com");
  expect(created.name).toBe("Factory User");
});
