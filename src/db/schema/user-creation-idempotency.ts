import { char, index, pgTable, primaryKey, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const userCreationIdempotency = pgTable(
  "user_creation_idempotency",
  {
    tenantId: varchar("tenant_id", { length: 128 }).notNull(),
    keyHash: char("key_hash", { length: 64 }).notNull(),
    requestFingerprint: char("request_fingerprint", { length: 64 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.keyHash] }),
    index("user_creation_idempotency_expires_cleanup_idx").on(
      table.expiresAt,
      table.tenantId,
      table.keyHash,
    ),
  ],
);
