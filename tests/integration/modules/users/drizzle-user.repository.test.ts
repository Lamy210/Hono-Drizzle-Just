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

test("pagination index matches tenant filtering and descending list order", async () => {
  const definition = await database.pool.query<{ indexdef: string }>(
    `select indexdef
       from pg_indexes
      where schemaname = current_schema()
        and tablename = 'users'
        and indexname = 'users_tenant_created_id_idx'`,
  );

  expect(definition.rows).toHaveLength(1);
  expect(definition.rows[0]?.indexdef).toContain(
    "USING btree (tenant_id, created_at DESC, id DESC)",
  );
  expect(definition.rows[0]?.indexdef).not.toContain("NULLS LAST");

  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const explained = await client.query(
      `explain (format json)
       select id, tenant_id, email, name, created_at
         from users
        where tenant_id = 'tenant-plan'
        order by created_at desc, id desc
        limit 20`,
    );
    const plan = JSON.stringify(explained.rows[0]);
    expect(plan).toContain("users_tenant_created_id_idx");
    expect(plan).not.toContain('"Node Type":"Sort"');
  } finally {
    await client.query("rollback");
    client.release();
  }
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

test("delete is tenant-scoped, version-guarded, and preserves stale rows", async () => {
  const created = await repository.create({
    tenantId: "tenant-a",
    email: `delete-${crypto.randomUUID()}@example.com`,
    name: "Delete",
  });

  expect(
    await repository.deleteById(
      "tenant-b",
      created.id,
      { kind: "versions", versions: [created.version] },
    ),
  ).toEqual({ state: "not_found" });
  expect(await repository.findById("tenant-a", created.id)).toEqual(created);

  expect(
    await repository.deleteById(
      "tenant-a",
      created.id,
      { kind: "versions", versions: [created.version + 1] },
    ),
  ).toEqual({ state: "precondition_failed" });
  expect(await repository.findById("tenant-a", created.id)).toEqual(created);

  expect(
    await repository.deleteById(
      "tenant-a",
      created.id,
      { kind: "versions", versions: [created.version] },
    ),
  ).toEqual({ state: "deleted" });
  expect(await repository.findById("tenant-a", created.id)).toBeNull();

  expect(
    await repository.deleteById("tenant-a", created.id, { kind: "any-current" }),
  ).toEqual({ state: "not_found" });
});

test("update is tenant-scoped, version-guarded, and increments version atomically", async () => {
  const created = await repository.create({
    tenantId: "tenant-a",
    email: `update-${crypto.randomUUID()}@example.com`,
    name: "Before",
  });
  expect(created.version).toBe(1);

  expect(
    await repository.update(
      "tenant-b",
      created.id,
      { name: "Cross tenant" },
      { kind: "versions", versions: [created.version] },
    ),
  ).toEqual({ state: "not_found" });

  const nextEmail = `updated-${crypto.randomUUID()}@example.com`;
  const updated = await repository.update(
    "tenant-a",
    created.id,
    { email: nextEmail, name: "After" },
    { kind: "versions", versions: [created.version] },
  );

  expect(updated).toMatchObject({
    state: "updated",
    user: {
      id: created.id,
      tenantId: "tenant-a",
      email: nextEmail,
      name: "After",
      version: 2,
    },
  });
  if (updated.state === "updated") {
    expect(updated.user.createdAt).toBeInstanceOf(Date);
    expect(updated.user.createdAt.toISOString()).toBe(created.createdAt.toISOString());
  }

  expect(
    await repository.update(
      "tenant-a",
      created.id,
      { name: "Stale overwrite" },
      { kind: "versions", versions: [created.version] },
    ),
  ).toEqual({ state: "precondition_failed" });

  expect(await repository.findById("tenant-a", created.id)).toMatchObject({
    name: "After",
    version: 2,
  });
});

async function waitForBlockedAtomicUserMutation(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await database.pool.query<{ blocked: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and (
              query ilike '%with updated as%'
              or query ilike '%with deleted as%'
            )
       ) as blocked`,
    );
    if (result.rows[0]?.blocked) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for blocked atomic user mutation");
}

test("conditional update classifies a concurrent delete as precondition failure from one statement snapshot", async () => {
  const created = await repository.create({
    tenantId: "tenant-a",
    email: `atomic-update-${crypto.randomUUID()}@example.com`,
    name: "Before",
  });
  const blocker = await database.pool.connect();
  let inTransaction = false;

  try {
    await blocker.query("begin");
    inTransaction = true;
    await blocker.query(
      "delete from users where tenant_id = $1 and id = $2",
      ["tenant-a", created.id],
    );

    const pending = repository.update(
      "tenant-a",
      created.id,
      { name: "Should not win" },
      { kind: "versions", versions: [created.version] },
    );
    await waitForBlockedAtomicUserMutation();

    await blocker.query("commit");
    inTransaction = false;

    expect(await pending).toEqual({ state: "precondition_failed" });
    expect(await repository.findById("tenant-a", created.id)).toBeNull();
  } finally {
    if (inTransaction) {
      await blocker.query("rollback").catch(() => undefined);
    }
    blocker.release();
  }
});

test("conditional delete classifies a concurrent delete as precondition failure from one statement snapshot", async () => {
  const created = await repository.create({
    tenantId: "tenant-a",
    email: `atomic-delete-${crypto.randomUUID()}@example.com`,
    name: "Delete",
  });
  const blocker = await database.pool.connect();
  let inTransaction = false;

  try {
    await blocker.query("begin");
    inTransaction = true;
    await blocker.query(
      "delete from users where tenant_id = $1 and id = $2",
      ["tenant-a", created.id],
    );

    const pending = repository.deleteById(
      "tenant-a",
      created.id,
      { kind: "versions", versions: [created.version] },
    );
    await waitForBlockedAtomicUserMutation();

    await blocker.query("commit");
    inTransaction = false;

    expect(await pending).toEqual({ state: "precondition_failed" });
    expect(await repository.findById("tenant-a", created.id)).toBeNull();
  } finally {
    if (inTransaction) {
      await blocker.query("rollback").catch(() => undefined);
    }
    blocker.release();
  }
});

test("update maps tenant-local email uniqueness violations to conflict", async () => {
  const first = await repository.create({
    tenantId: "tenant-a",
    email: `update-first-${crypto.randomUUID()}@example.com`,
    name: "First",
  });
  const second = await repository.create({
    tenantId: "tenant-a",
    email: `update-second-${crypto.randomUUID()}@example.com`,
    name: "Second",
  });

  await expect(
    repository.update(
      "tenant-a",
      second.id,
      { email: first.email },
      { kind: "versions", versions: [second.version] },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

  expect(await repository.findById("tenant-a", second.id)).toMatchObject({
    id: second.id,
    email: second.email,
    name: "Second",
  });
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

test("users persistence exposes a required version column with default 1", async () => {
  const result = await database.pool.query<{
    column_default: string | null;
    is_nullable: string;
    data_type: string;
  }>(
    `select column_default, is_nullable, data_type
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'users'
        and column_name = 'version'`,
  );

  expect(result.rows).toEqual([
    { column_default: "1", is_nullable: "NO", data_type: "integer" },
  ]);
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
