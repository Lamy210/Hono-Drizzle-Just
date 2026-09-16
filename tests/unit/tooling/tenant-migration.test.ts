import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const drizzleDir = join(import.meta.dir, "../../../drizzle");

test("tenant migration preserves legacy rows and replaces global email uniqueness", async () => {
  const files = (await readdir(drizzleDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(
    files.map(async (name) => ({ name, content: await Bun.file(join(drizzleDir, name)).text() })),
  );
  const tenantMigration = migrations.find(({ content }) => content.includes('"tenant_id"'));

  expect(tenantMigration).toBeDefined();
  if (!tenantMigration) {
    return;
  }

  expect(tenantMigration.name).not.toBe("0000_initial.sql");
  expect(tenantMigration.content).toContain('ADD COLUMN "tenant_id" varchar(128)');
  expect(tenantMigration.content).toContain("__legacy__:");
  expect(tenantMigration.content).toContain('ALTER COLUMN "tenant_id" SET NOT NULL');
  expect(tenantMigration.content).toContain('DROP CONSTRAINT "users_email_unique"');
  expect(tenantMigration.content).toContain(
    'CONSTRAINT "users_tenant_id_email_unique" UNIQUE("tenant_id","email")',
  );
});
