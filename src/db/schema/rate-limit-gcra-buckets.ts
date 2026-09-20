import { char, index, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

export const rateLimitGcraBuckets = pgTable(
  "rate_limit_gcra_buckets",
  {
    scope: varchar("scope", { length: 100 }).notNull(),
    identityHash: char("identity_hash", { length: 64 }).notNull(),
    theoreticalArrivalAt: timestamp("theoretical_arrival_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.identityHash] }),
    index("rate_limit_gcra_buckets_expires_at_scope_identity_hash_idx").on(
      table.expiresAt,
      table.scope,
      table.identityHash,
    ),
  ],
);
