import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const drizzleDir = join(import.meta.dir, "../../../drizzle");

test("idempotency ledger is introduced by a forward migration after tenant ownership", async () => {
  const files = (await readdir(drizzleDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(
    files.map(async (name) => ({ name, content: await Bun.file(join(drizzleDir, name)).text() })),
  );
  const migration = migrations.find(({ content }) =>
    content.includes('CREATE TABLE "user_creation_idempotency"'),
  );

  expect(migration).toBeDefined();
  if (!migration) return;

  expect(migration.name).toMatch(/^0002_/);
  expect(migration.content).toContain('"tenant_id" varchar(128) NOT NULL');
  expect(migration.content).toContain('"key_hash" char(64) NOT NULL');
  expect(migration.content).toContain('"request_fingerprint" char(64) NOT NULL');
  expect(migration.content).toContain('"user_id" uuid');
  expect(migration.content).toContain('"claimed_at" timestamp with time zone DEFAULT now() NOT NULL');
  expect(migration.content).toContain('"expires_at" timestamp with time zone NOT NULL');
  expect(migration.content).toContain('PRIMARY KEY("tenant_id","key_hash")');
  expect(migration.content).toContain('REFERENCES "public"."users"("id") ON DELETE cascade');

  const baseline = migrations.find(({ name }) => name === "0000_initial.sql");
  const tenant = migrations.find(({ name }) => name === "0001_mean_barracuda.sql");
  expect(baseline?.content).not.toContain("user_creation_idempotency");
  expect(tenant?.content).not.toContain("user_creation_idempotency");
});
