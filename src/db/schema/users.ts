import { index, pgTable, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: varchar("tenant_id", { length: 128 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    unique("users_tenant_id_email_unique").on(table.tenantId, table.email),
    index("users_tenant_created_id_idx").on(
      table.tenantId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);
