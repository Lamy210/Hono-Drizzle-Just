import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../src/db/schema";
import { users } from "../../src/db/schema";

export type UserFactoryOverrides = Partial<{
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}>;

let sequence = 0;

export async function createUserFactory(
  db: NodePgDatabase<typeof schema>,
  overrides: UserFactoryOverrides = {},
) {
  sequence += 1;
  const values = {
    id: overrides.id ?? crypto.randomUUID(),
    email: overrides.email ?? `user-${sequence}@example.com`,
    name: overrides.name ?? `User ${sequence}`,
    createdAt: overrides.createdAt ?? new Date("2026-09-13T00:00:00.000Z"),
  };

  const [created] = await db.insert(users).values(values).returning();
  if (!created) {
    throw new Error("Factory failed to create user");
  }
  return created;
}
