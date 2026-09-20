import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rateLimitGcraBuckets } from "../../../src/db/schema";
import { Sha256StringDigester } from "../../../src/infrastructure/crypto/sha256-string-digester";
import { PostgresGcraRateLimiter } from "../../../src/infrastructure/rate-limit/postgres-gcra-rate-limiter";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const digester = new Sha256StringDigester();

beforeAll(async () => {
  await database.pool.query("select 1");
});

beforeEach(async () => {
  await database.db.delete(rateLimitGcraBuckets);
});

afterAll(async () => {
  await database.close();
});

test("atomically caps an initial GCRA burst under concurrency", async () => {
  const limiter = new PostgresGcraRateLimiter(database.db, digester, {
    limit: 5,
    windowSeconds: 60,
  });
  const identity = "203.0.113.120";

  const decisions = await Promise.all(
    Array.from({ length: 20 }, () => limiter.consume({ scope: "http.global", identity })),
  );

  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(15);

  const rows = await database.db.select().from(rateLimitGcraBuckets);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.identityHash).toBe(digester.sha256Hex(`http.global\\0${identity}`));
  expect(JSON.stringify(rows[0])).not.toContain(identity);
});

test("restores GCRA capacity gradually instead of waiting for a fixed-window rollover", async () => {
  const limiter = new PostgresGcraRateLimiter(database.db, digester, {
    limit: 2,
    windowSeconds: 10,
  });
  const request = { scope: "http.global", identity: "198.51.100.120" } as const;

  expect(await limiter.consume(request)).toMatchObject({
    allowed: true,
    quota: { limit: 2, remaining: 1, windowSeconds: 10 },
  });
  expect(await limiter.consume(request)).toMatchObject({
    allowed: true,
    quota: { limit: 2, remaining: 0, windowSeconds: 10 },
  });
  expect((await limiter.consume(request)).allowed).toBe(false);

  const identityHash = digester.sha256Hex(`http.global\\0${request.identity}`);
  const nearlyEligible = new Date(Date.now() + 4_000);
  await database.db
    .update(rateLimitGcraBuckets)
    .set({
      theoreticalArrivalAt: nearlyEligible,
      expiresAt: nearlyEligible,
    })
    .where(eq(rateLimitGcraBuckets.identityHash, identityHash));

  const recovered = await limiter.consume(request);
  expect(recovered.allowed).toBe(true);
  expect(recovered.quota?.remaining).toBe(0);
});

test("keeps GCRA scopes and policy overrides independent", async () => {
  const limiter = new PostgresGcraRateLimiter(database.db, digester, {
    limit: 3,
    windowSeconds: 60,
    policies: {
      "http.users.write": { limit: 1, windowSeconds: 10 },
      "http.users.read": { limit: 2, windowSeconds: 20 },
    },
  });
  const identity = "198.51.100.121";

  expect(await limiter.consume({ scope: "http.users.write", identity })).toMatchObject({
    allowed: true,
    quota: { policyId: "http.users.write", limit: 1, remaining: 0, windowSeconds: 10 },
  });
  expect((await limiter.consume({ scope: "http.users.write", identity })).allowed).toBe(false);

  expect(await limiter.consume({ scope: "http.users.read", identity })).toMatchObject({
    allowed: true,
    quota: { policyId: "http.users.read", limit: 2, remaining: 1, windowSeconds: 20 },
  });
  expect(await limiter.consume({ scope: "http.users.read", identity })).toMatchObject({
    allowed: true,
    quota: { policyId: "http.users.read", limit: 2, remaining: 0, windowSeconds: 20 },
  });
  expect((await limiter.consume({ scope: "http.users.read", identity })).allowed).toBe(false);

  const rows = await database.db.select().from(rateLimitGcraBuckets);
  expect(rows).toHaveLength(2);
});

test("returns retry metadata from the theoretical arrival debt", async () => {
  const limiter = new PostgresGcraRateLimiter(database.db, digester, {
    limit: 1,
    windowSeconds: 10,
  });
  const request = { scope: "http.global", identity: "192.0.2.120" } as const;

  expect((await limiter.consume(request)).allowed).toBe(true);
  const denied = await limiter.consume(request);
  expect(denied.allowed).toBe(false);
  if (!denied.allowed) {
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(10);
    expect(denied.quota).toMatchObject({
      policyId: "http.global",
      limit: 1,
      remaining: 0,
      windowSeconds: 10,
    });
    expect(denied.quota?.resetAfterSeconds).toBeGreaterThanOrEqual(denied.retryAfterSeconds);
  }
});

test("bounded cleanup removes expired GCRA state before consuming", async () => {
  const expiredRows = Array.from({ length: 1_005 }, (_, index) => ({
    scope: "http.global",
    identityHash: digester.sha256Hex(`http.global\\0gcra-expired-${index}`),
    theoreticalArrivalAt: new Date(0),
    expiresAt: new Date(0),
  }));
  await database.db.insert(rateLimitGcraBuckets).values(expiredRows);

  const limiter = new PostgresGcraRateLimiter(database.db, digester, {
    limit: 10,
    windowSeconds: 60,
  });
  await limiter.consume({ scope: "http.global", identity: "203.0.113.122" });

  const rows = await database.db.select().from(rateLimitGcraBuckets);
  expect(rows.filter((row) => row.expiresAt.getTime() === 0)).toHaveLength(5);
  expect(rows).toHaveLength(6);
});

test("rejects invalid GCRA policy and request input", async () => {
  expect(
    () => new PostgresGcraRateLimiter(database.db, digester, { limit: 0, windowSeconds: 60 }),
  ).toThrow(TypeError);
  expect(
    () =>
      new PostgresGcraRateLimiter(database.db, digester, {
        limit: 1,
        windowSeconds: 60,
        policies: { "bad scope": { limit: 1, windowSeconds: 60 } },
      }),
  ).toThrow(TypeError);

  const limiter = new PostgresGcraRateLimiter(database.db, digester, {
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
