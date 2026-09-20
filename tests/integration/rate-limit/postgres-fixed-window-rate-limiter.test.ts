import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rateLimitBuckets } from "../../../src/db/schema";
import { Sha256StringDigester } from "../../../src/infrastructure/crypto/sha256-string-digester";
import { PostgresFixedWindowRateLimiter } from "../../../src/infrastructure/rate-limit/postgres-fixed-window-rate-limiter";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const digester = new Sha256StringDigester();

beforeAll(async () => {
  await database.pool.query("select 1");
});

beforeEach(async () => {
  await database.db.delete(rateLimitBuckets);
});

afterAll(async () => {
  await database.close();
});

test("atomically enforces one shared fixed-window limit under concurrency", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 5,
    windowSeconds: 60,
  });

  const decisions = await Promise.all(
    Array.from({ length: 20 }, () =>
      limiter.consume({ scope: "http.global", identity: "203.0.113.10" }),
    ),
  );

  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(15);

  const [bucket] = await database.db.select().from(rateLimitBuckets);
  expect(bucket?.requestCount).toBe(20);
  expect(bucket?.identityHash).toBe(digester.sha256Hex("http.global\0" + "203.0.113.10"));
  expect(JSON.stringify(bucket)).not.toContain("203.0.113.10");
});

test("keeps scopes and client identities isolated", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 1,
    windowSeconds: 60,
  });

  expect(await limiter.consume({ scope: "http.global", identity: "198.51.100.10" })).toEqual({
    allowed: true,
  });
  expect(await limiter.consume({ scope: "http.global", identity: "198.51.100.11" })).toEqual({
    allowed: true,
  });
  expect(await limiter.consume({ scope: "users.write", identity: "198.51.100.10" })).toEqual({
    allowed: true,
  });

  const rows = await database.db.select().from(rateLimitBuckets);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((row) => row.identityHash)).size).toBe(3);
});

test("applies independent scope-specific limits and windows", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 3,
    windowSeconds: 60,
    policies: {
      "http.users.write": { limit: 1, windowSeconds: 10 },
      "http.users.read": { limit: 2, windowSeconds: 30 },
    },
  });
  const identity = "198.51.100.77";

  expect(await limiter.consume({ scope: "http.users.write", identity })).toEqual({
    allowed: true,
  });
  const writeDenied = await limiter.consume({ scope: "http.users.write", identity });
  expect(writeDenied.allowed).toBe(false);
  if (!writeDenied.allowed) {
    expect(writeDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(writeDenied.retryAfterSeconds).toBeLessThanOrEqual(10);
  }

  expect(await limiter.consume({ scope: "http.users.read", identity })).toEqual({ allowed: true });
  expect(await limiter.consume({ scope: "http.users.read", identity })).toEqual({ allowed: true });
  const readDenied = await limiter.consume({ scope: "http.users.read", identity });
  expect(readDenied.allowed).toBe(false);
  if (!readDenied.allowed) {
    expect(readDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(readDenied.retryAfterSeconds).toBeLessThanOrEqual(30);
  }

  for (let index = 0; index < 3; index += 1) {
    expect(await limiter.consume({ scope: "http.global", identity })).toEqual({ allowed: true });
  }
  const globalDenied = await limiter.consume({ scope: "http.global", identity });
  expect(globalDenied.allowed).toBe(false);
  if (!globalDenied.allowed) {
    expect(globalDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(globalDenied.retryAfterSeconds).toBeLessThanOrEqual(60);
  }
});

test("resets an expired bucket atomically instead of growing one row per window", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 1,
    windowSeconds: 60,
  });
  const request = { scope: "http.global", identity: "192.0.2.25" } as const;

  expect(await limiter.consume(request)).toEqual({ allowed: true });
  const denied = await limiter.consume(request);
  expect(denied.allowed).toBe(false);
  if (!denied.allowed) {
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  }

  const identityHash = digester.sha256Hex("http.global\0" + request.identity);
  await database.db
    .update(rateLimitBuckets)
    .set({ expiresAt: new Date(0) })
    .where(eq(rateLimitBuckets.identityHash, identityHash));

  expect(await limiter.consume(request)).toEqual({ allowed: true });

  const rows = await database.db
    .select()
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.identityHash, identityHash));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.requestCount).toBe(1);
  expect(rows[0]?.windowStartedAt.getTime()).toBeGreaterThan(0);
});

test("periodic hot-path cleanup removes expired identities before consuming", async () => {
  const expiredHash = digester.sha256Hex("http.global\0expired-client");
  await database.db.insert(rateLimitBuckets).values({
    scope: "http.global",
    identityHash: expiredHash,
    windowStartedAt: new Date(0),
    requestCount: 99,
    expiresAt: new Date(0),
  });

  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 10,
    windowSeconds: 60,
  });
  await limiter.consume({ scope: "http.global", identity: "203.0.113.44" });

  const expired = await database.db
    .select()
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.identityHash, expiredHash));
  expect(expired).toHaveLength(0);
});

test("rejects invalid adapter configuration and malformed generic identities", async () => {
  expect(
    () =>
      new PostgresFixedWindowRateLimiter(database.db, digester, {
        limit: 0,
        windowSeconds: 60,
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new PostgresFixedWindowRateLimiter(database.db, digester, {
        limit: 1,
        windowSeconds: 86_401,
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new PostgresFixedWindowRateLimiter(database.db, digester, {
        limit: 1,
        windowSeconds: 60,
        policies: { "http.users.write": { limit: 0, windowSeconds: 60 } },
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new PostgresFixedWindowRateLimiter(database.db, digester, {
        limit: 1,
        windowSeconds: 60,
        policies: { "bad scope": { limit: 1, windowSeconds: 60 } },
      }),
  ).toThrow(TypeError);

  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 1,
    windowSeconds: 60,
  });
  await expect(limiter.consume({ scope: "bad scope", identity: "203.0.113.10" })).rejects.toThrow(
    TypeError,
  );
  await expect(limiter.consume({ scope: "http.global", identity: "bad\nidentity" })).rejects.toThrow(
    TypeError,
  );
});
