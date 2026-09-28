import { expect, test } from "bun:test";
import { join } from "node:path";

const migrationPath = join(
  import.meta.dir,
  "../../../drizzle/0009_user_cursor_timestamp_precision.sql",
);

test("user cursor timestamp precision is normalized by a forward migration", async () => {
  const migration = await Bun.file(migrationPath).text();

  expect(migration).toContain(
    'ALTER COLUMN "created_at" TYPE timestamp(3) with time zone',
  );
  expect(migration).toContain(
    `USING date_trunc('milliseconds', "created_at")`,
  );
});
