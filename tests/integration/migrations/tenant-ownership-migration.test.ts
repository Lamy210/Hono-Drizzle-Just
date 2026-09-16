import { afterAll, expect, test } from "bun:test";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const root = new URL("../../../", import.meta.url);

async function migrationSql(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

afterAll(async () => {
  await database.close();
});

test("tenant migration upgrades an existing baseline row into an inaccessible legacy tenant", async () => {
  const client = await database.pool.connect();
  const schema = `tenant_migration_${crypto.randomUUID().replaceAll("-", "_")}`;
  const initialSql = await migrationSql("drizzle/0000_initial.sql");
  const tenantSql = await migrationSql("drizzle/0001_mean_barracuda.sql");

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(initialSql);

    const inserted = await client.query<{ id: string; email: string; name: string }>(
      `INSERT INTO users (email, name)
       VALUES ($1, $2)
       RETURNING id::text, email, name`,
      ["legacy@example.com", "Legacy User"],
    );
    const legacy = inserted.rows[0];
    expect(legacy).toBeDefined();
    if (!legacy) {
      return;
    }

    await client.query(tenantSql);

    const migrated = await client.query<{
      id: string;
      tenant_id: string;
      email: string;
      name: string;
    }>(
      `SELECT id::text, tenant_id, email, name
         FROM users
        WHERE id = $1::uuid`,
      [legacy.id],
    );

    expect(migrated.rows).toEqual([
      {
        id: legacy.id,
        tenant_id: `__legacy__:${legacy.id}`,
        email: "legacy@example.com",
        name: "Legacy User",
      },
    ]);

    const constraints = await client.query<{ constraint_name: string }>(
      `SELECT constraint_name
         FROM information_schema.table_constraints
        WHERE table_schema = $1
          AND table_name = 'users'
          AND constraint_type = 'UNIQUE'
        ORDER BY constraint_name`,
      [schema],
    );
    expect(constraints.rows.map((row) => row.constraint_name)).toEqual([
      "users_tenant_id_email_unique",
    ]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
