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

  const found = await repository.findById(seeded.tenantId, seeded.id);

  expect(found).not.toBeNull();
  expect(found?.email).toBe("seed@example.com");
});

test("repository scopes ID and email reads to the requested tenant", async () => {
  const email = `tenant-scope-${crypto.randomUUID()}@example.com`;
  const created = await repository.create({ tenantId: "tenant-a", email, name: "Tenant A" });

  expect(await repository.findById("tenant-a", created.id)).toEqual(created);
  expect(await repository.findByEmail("tenant-a", email)).toEqual(created);
  expect(await repository.findById("tenant-b", created.id)).toBeNull();
  expect(await repository.findByEmail("tenant-b", email)).toBeNull();
});

test("paginated listing is tenant-scoped, deterministic, and preserves the tenant total", async () => {
  await database.db.insert(users).values([
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      tenantId: "tenant-a",
      email: "old@example.com",
      name: "Old",
      createdAt: new Date("2026-09-18T00:00:00.000Z"),
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440002",
      tenantId: "tenant-a",
      email: "middle@example.com",
      name: "Middle",
      createdAt: new Date("2026-09-19T00:00:00.000Z"),
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440003",
      tenantId: "tenant-a",
      email: "new@example.com",
      name: "New",
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440004",
      tenantId: "tenant-b",
      email: "other@example.com",
      name: "Other tenant",
      createdAt: new Date("2026-09-21T00:00:00.000Z"),
    },
  ]);

  const page = await repository.listPage("tenant-a", { offset: 1, limit: 1 });
  expect(page.total).toBe(3);
  expect(page.users.map((user) => user.email)).toEqual(["middle@example.com"]);

  const beyondEnd = await repository.listPage("tenant-a", { offset: 10, limit: 2 });
  expect(beyondEnd).toEqual({ users: [], total: 3 });
});

test("the same normalized email can exist in separate tenants", async () => {
  const email = `shared-${crypto.randomUUID()}@example.com`;

  const tenantA = await repository.create({ tenantId: "tenant-a", email, name: "Tenant A" });
  const tenantB = await repository.create({ tenantId: "tenant-b", email, name: "Tenant B" });

  expect(tenantA.email).toBe(email);
  expect(tenantB.email).toBe(email);
  expect(tenantA.id).not.toBe(tenantB.id);
});

test("repository maps a wrapped PostgreSQL tenant-local unique violation to a conflict AppError", async () => {
  const email = `duplicate-${crypto.randomUUID()}@example.com`;
  await repository.create({ tenantId: "tenant-a", email, name: "First" });

  await expect(
    repository.create({ tenantId: "tenant-a", email, name: "Duplicate" }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    status: 409,
  });
});

test("users persistence exposes a required varchar(128) tenant_id column", async () => {
  const result = await database.pool.query<{
    is_nullable: string;
    character_maximum_length: number | null;
  }>(
    `select is_nullable, character_maximum_length
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'users'
        and column_name = 'tenant_id'`,
  );

  expect(result.rows).toEqual([{ is_nullable: "NO", character_maximum_length: 128 }]);
});
