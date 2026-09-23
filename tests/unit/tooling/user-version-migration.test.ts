import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const drizzleDir = join(import.meta.dir, "../../../drizzle");

test("user optimistic concurrency is introduced by a forward migration", async () => {
  const files = (await readdir(drizzleDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  const versionMigration = files.find((name) => name.startsWith("0007_"));
  expect(versionMigration).toBe("0007_lethal_silverclaw.sql");
  if (!versionMigration) return;

  const sql = await Bun.file(join(drizzleDir, versionMigration)).text();
  expect(sql).toBe(
    'ALTER TABLE "users" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;',
  );
});
