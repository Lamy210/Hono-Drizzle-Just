import { char, integer, pgTable, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    scope: varchar("scope", { length: 100 }).notNull(),
    identityHash: char("identity_hash", { length: 64 }).notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "date" })
      .defaultNow()
      .notNull(),
    requestCount: integer("request_count").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.identityHash] })],
);
