import { afterAll, beforeAll, expect, test } from "bun:test";
import { DrizzleUserRepository } from "../../../../src/modules/users/infrastructure/drizzle-user.repository";
import { createTestDatabase } from "../../../helpers/database";

const database = createTestDatabase();
const users = new DrizzleUserRepository(database.db);
const repositoryModulePath =
  "../../../../src/modules/users/infrastructure/drizzle-user-creation-idempotency.repository";

async function loadRepositoryModule() {
  return import(repositoryModulePath).catch(() => undefined);
}

function hash(character: string): string {
  return character.repeat(64);
}

beforeAll(async () => {
  await database.pool.query("select 1");
});

afterAll(async () => {
  await database.close();
});

test("idempotency repository claims, completes, and replays an active tenant-local key", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db);
  const tenantId = `tenant-idem-${crypto.randomUUID()}`;
  const keyHash = hash("a");
  const requestFingerprint = hash("b");

  expect(
    await repository.claim({ tenantId, keyHash, requestFingerprint, ttlSeconds: 86_400 }),
  ).toEqual({ state: "claimed" });

  const user = await users.create({
    tenantId,
    email: `${crypto.randomUUID()}@example.com`,
    name: "Idempotent User",
  });
  await repository.complete({ tenantId, keyHash, requestFingerprint, userId: user.id });

  expect(
    await repository.claim({ tenantId, keyHash, requestFingerprint, ttlSeconds: 86_400 }),
  ).toEqual({
    state: "existing",
    record: { requestFingerprint, userId: user.id },
  });
});

test("deleting a user cascades its completed idempotency ledger row", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db);
  const tenantId = `tenant-delete-cascade-${crypto.randomUUID()}`;
  const keyHash = hash("8");
  const requestFingerprint = hash("9");

  expect(
    await repository.claim({ tenantId, keyHash, requestFingerprint, ttlSeconds: 86_400 }),
  ).toEqual({ state: "claimed" });

  const user = await users.create({
    tenantId,
    email: `${crypto.randomUUID()}@example.com`,
    name: "Delete Cascade",
  });
  await repository.complete({ tenantId, keyHash, requestFingerprint, userId: user.id });

  expect(await users.deleteById(tenantId, user.id)).toBe(true);

  const persisted = await database.pool.query<{ count: string }>(
    `select count(*)::text as count
       from user_creation_idempotency
      where tenant_id = $1 and key_hash = $2`,
    [tenantId, keyHash],
  );
  expect(persisted.rows).toEqual([{ count: "0" }]);

  expect(
    await repository.claim({ tenantId, keyHash, requestFingerprint, ttlSeconds: 86_400 }),
  ).toEqual({ state: "claimed" });
});

test("the same key hash is independent across tenants", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db);
  const keyHash = hash("c");
  const requestFingerprint = hash("d");
  const suffix = crypto.randomUUID();

  expect(
    await repository.claim({
      tenantId: `tenant-a-${suffix}`,
      keyHash,
      requestFingerprint,
      ttlSeconds: 86_400,
    }),
  ).toEqual({ state: "claimed" });
  expect(
    await repository.claim({
      tenantId: `tenant-b-${suffix}`,
      keyHash,
      requestFingerprint,
      ttlSeconds: 86_400,
    }),
  ).toEqual({ state: "claimed" });
});

test("an expired key is reclaimed with a new fingerprint and an incomplete user pointer", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db);
  const tenantId = `tenant-expired-${crypto.randomUUID()}`;
  const keyHash = hash("e");
  const oldFingerprint = hash("f");
  const newFingerprint = hash("1");

  await database.pool.query(
    `insert into user_creation_idempotency
      (tenant_id, key_hash, request_fingerprint, user_id, claimed_at, expires_at)
     values ($1, $2, $3, null, now() - interval '2 days', now() - interval '1 second')`,
    [tenantId, keyHash, oldFingerprint],
  );

  expect(
    await repository.claim({ tenantId, keyHash, requestFingerprint: newFingerprint, ttlSeconds: 86_400 }),
  ).toEqual({ state: "claimed" });

  const persisted = await database.pool.query<{
    request_fingerprint: string;
    user_id: string | null;
    active: boolean;
  }>(
    `select request_fingerprint, user_id, expires_at > now() as active
       from user_creation_idempotency
      where tenant_id = $1 and key_hash = $2`,
    [tenantId, keyHash],
  );
  expect(persisted.rows).toEqual([
    { request_fingerprint: newFingerprint, user_id: null, active: true },
  ]);
});

test("complete fails closed unless exactly one matching incomplete claim exists", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db);
  await expect(
    repository.complete({
      tenantId: `tenant-missing-${crypto.randomUUID()}`,
      keyHash: hash("2"),
      requestFingerprint: hash("3"),
      userId: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 });
});

test("ledger stores only supplied hashes and exposes the required schema constraints", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db);
  const rawKey = `raw-key-${crypto.randomUUID()}`;
  const tenantId = `tenant-schema-${crypto.randomUUID()}`;
  const keyHash = hash("4");
  const requestFingerprint = hash("5");
  await repository.claim({ tenantId, keyHash, requestFingerprint, ttlSeconds: 86_400 });

  const row = await database.pool.query<{ serialized: string }>(
    `select row_to_json(t)::text as serialized
       from user_creation_idempotency t
      where tenant_id = $1 and key_hash = $2`,
    [tenantId, keyHash],
  );
  expect(row.rows[0]?.serialized).toContain(keyHash);
  expect(row.rows[0]?.serialized).toContain(requestFingerprint);
  expect(row.rows[0]?.serialized).not.toContain(rawKey);

  const columns = await database.pool.query<{
    column_name: string;
    data_type: string;
    character_maximum_length: number | null;
    is_nullable: string;
  }>(
    `select column_name, data_type, character_maximum_length, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = 'user_creation_idempotency'
      order by ordinal_position`,
  );
  expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
    "tenant_id",
    "key_hash",
    "request_fingerprint",
    "user_id",
    "claimed_at",
    "expires_at",
  ]);
  expect(columns.rows.find(({ column_name }) => column_name === "tenant_id")).toMatchObject({
    data_type: "character varying",
    character_maximum_length: 128,
    is_nullable: "NO",
  });
  expect(columns.rows.find(({ column_name }) => column_name === "key_hash")).toMatchObject({
    data_type: "character",
    character_maximum_length: 64,
    is_nullable: "NO",
  });

  const constraints = await database.pool.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'user_creation_idempotency'::regclass`,
  );
  const definitions = constraints.rows.map(({ definition }) => definition).join("\n");
  expect(definitions).toContain("PRIMARY KEY (tenant_id, key_hash)");
  expect(definitions).toContain("FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE");
});

test("concurrent first claims serialize so only one transaction owns the key", async () => {
  const module = await loadRepositoryModule();
  expect(module).toBeDefined();
  if (!module) return;

  const tenantId = `tenant-concurrent-${crypto.randomUUID()}`;
  const keyHash = hash("6");
  const requestFingerprint = hash("7");

  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstClaimed!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    firstClaimed = resolve;
  });

  const first = database.db.transaction(async (transaction) => {
    const repository = new module.DrizzleUserCreationIdempotencyRepository(transaction);
    const result = await repository.claim({
      tenantId,
      keyHash,
      requestFingerprint,
      ttlSeconds: 86_400,
    });
    firstClaimed();
    await holdFirst;
    return result;
  });

  await firstReady;

  let secondResolved = false;
  const second = database.db.transaction(async (transaction) => {
    const repository = new module.DrizzleUserCreationIdempotencyRepository(transaction);
    const result = await repository.claim({
      tenantId,
      keyHash,
      requestFingerprint,
      ttlSeconds: 86_400,
    });
    secondResolved = true;
    return result;
  });

  await Bun.sleep(100);
  expect(secondResolved).toBe(false);
  releaseFirst();

  expect(await first).toEqual({ state: "claimed" });
  expect(await second).toEqual({
    state: "existing",
    record: { requestFingerprint, userId: null },
  });
});
