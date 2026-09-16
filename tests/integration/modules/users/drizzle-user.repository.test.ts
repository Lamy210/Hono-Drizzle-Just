import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { users } from "../../../../src/db/schema";
import type { User } from "../../../../src/modules/users/domain/user";
import { DrizzleUserRepository } from "../../../../src/modules/users/infrastructure/drizzle-user.repository";
import { makeUserFactory } from "../../../factories/user.factory";
import { createTestDatabase } from "../../../helpers/database";

const database = createTestDatabase();
const repository = new DrizzleUserRepository(database.db);
const userFactory = makeUserFactory(database.db);

interface TenantAwareRepository {
  findById(tenantId: string, id: string): Promise<User | null>;
  findByEmail(tenantId: string, email: string): Promise<User | null>;
  create(input: { tenantId: string; email: string; name: string }): Promise<User>;
}

const tenantRepository = repository as unknown as TenantAwareRepository;

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

test("repository scopes ID and email reads to the requested tenant", async () => {
  const email = `tenant-scope-${crypto.randomUUID()}@example.com`;
  const created = await tenantRepository.create({ tenantId: "tenant-a", email, name: "Tenant A" });

  expect(await tenantRepository.findById("tenant-a", created.id)).toEqual(created);
  expect(await tenantRepository.findByEmail("tenant-a", email)).toEqual(created);
  expect(await tenantRepository.findById("tenant-b", created.id)).toBeNull();
  expect(await tenantRepository.findByEmail("tenant-b", email)).toBeNull();
});

test("the same normalized email can exist in separate tenants", async () => {
  const email = `shared-${crypto.randomUUID()}@example.com`;

  const tenantA = await tenantRepository.create({ tenantId: "tenant-a", email, name: "Tenant A" });
  const tenantB = await tenantRepository.create({ tenantId: "tenant-b", email, name: "Tenant B" });

  expect(tenantA.email).toBe(email);
  expect(tenantB.email).toBe(email);
  expect(tenantA.id).not.toBe(tenantB.id);
});

test("repository maps a wrapped PostgreSQL tenant-local unique violation to a conflict AppError", async () => {
  const email = `duplicate-${crypto.randomUUID()}@example.com`;
  await tenantRepository.create({ tenantId: "tenant-a", email, name: "First" });

  await expect(
    tenantRepository.create({ tenantId: "tenant-a", email, name: "Duplicate" }),
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
