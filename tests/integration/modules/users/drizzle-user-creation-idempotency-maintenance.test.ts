import { afterAll, beforeAll, expect, test } from "bun:test";
import { DrizzleUserCreationIdempotencyMaintenance } from "../../../../src/modules/users/infrastructure/drizzle-user-creation-idempotency-maintenance";
import { UserCreationIdempotencyCleanupGate } from "../../../../src/modules/users/infrastructure/user-creation-idempotency-cleanup-gate";
import { createTestDatabase } from "../../../helpers/database";

const database = createTestDatabase();

function hash(character: string): string {
  return character.repeat(64);
}

beforeAll(async () => {
  await database.pool.query("select 1");
});

afterAll(async () => {
  await database.close();
});

test("maintenance removes only expired rows and respects the shared cleanup cadence", async () => {
  const suffix = crypto.randomUUID();
  const expiredTenant = `tenant-maintenance-expired-${suffix}`;
  const activeTenant = `tenant-maintenance-active-${suffix}`;
  const secondExpiredTenant = `tenant-maintenance-second-${suffix}`;
  const expiredKey = hash("a");
  const activeKey = hash("b");
  const secondExpiredKey = hash("c");
  const fingerprint = hash("d");

  await database.pool.query(
    `insert into user_creation_idempotency
      (tenant_id, key_hash, request_fingerprint, user_id, claimed_at, expires_at)
     values
      ($1, $2, $3, null, now() - interval '2 days', now() - interval '1 hour'),
      ($4, $5, $3, null, now(), now() + interval '1 hour')`,
    [expiredTenant, expiredKey, fingerprint, activeTenant, activeKey],
  );

  let now = 1_000;
  const gate = new UserCreationIdempotencyCleanupGate(60_000, () => now);
  const maintenance = new DrizzleUserCreationIdempotencyMaintenance(database.db, gate);

  await maintenance.cleanupIfDue();

  const afterFirst = await database.pool.query<{ tenant_id: string }>(
    `select tenant_id
       from user_creation_idempotency
      where tenant_id = any($1::text[])
      order by tenant_id`,
    [[expiredTenant, activeTenant]],
  );
  expect(afterFirst.rows).toEqual([{ tenant_id: activeTenant }]);

  await database.pool.query(
    `insert into user_creation_idempotency
      (tenant_id, key_hash, request_fingerprint, user_id, claimed_at, expires_at)
     values ($1, $2, $3, null, now() - interval '2 days', now() - interval '1 hour')`,
    [secondExpiredTenant, secondExpiredKey, fingerprint],
  );

  await maintenance.cleanupIfDue();
  const beforeNextInterval = await database.pool.query<{ count: string }>(
    `select count(*)::text as count
       from user_creation_idempotency
      where tenant_id = $1 and key_hash = $2`,
    [secondExpiredTenant, secondExpiredKey],
  );
  expect(beforeNextInterval.rows).toEqual([{ count: "1" }]);

  now += 60_000;
  await maintenance.cleanupIfDue();

  const afterNextInterval = await database.pool.query<{ count: string }>(
    `select count(*)::text as count
       from user_creation_idempotency
      where tenant_id = $1 and key_hash = $2`,
    [secondExpiredTenant, secondExpiredKey],
  );
  expect(afterNextInterval.rows).toEqual([{ count: "0" }]);
});
