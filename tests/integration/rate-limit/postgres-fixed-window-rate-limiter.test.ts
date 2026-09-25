import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Meter } from "../../../src/core/observability/meter";
import type { TelemetryAttributes } from "../../../src/core/observability/tracer";
import { rateLimitBuckets } from "../../../src/db/schema";
import { Sha256StringDigester } from "../../../src/infrastructure/crypto/sha256-string-digester";
import { PostgresFixedWindowRateLimiter } from "../../../src/infrastructure/rate-limit/postgres-fixed-window-rate-limiter";
import { RateLimitObserver } from "../../../src/infrastructure/rate-limit/rate-limit-observer";
import { createTestDatabase } from "../../helpers/database";

const database = createTestDatabase();
const digester = new Sha256StringDigester();

class RecordingMeter implements Meter {
  readonly counters: Array<{
    name: string;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.counters.push({ name, value, ...(attributes ? { attributes } : {}) });
  }

  record(): void {}
}

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
  const identity = "203.0.113.10";
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 5,
    windowSeconds: 60,
  });

  const decisions = await Promise.all(
    Array.from({ length: 20 }, () =>
      limiter.consume({ scope: "http.global", identity }),
    ),
  );

  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(15);
  expect(
    decisions.every(
      (decision) =>
        decision.quota?.policyId === "http.global" &&
        decision.quota.limit === 5 &&
        decision.quota.windowSeconds === 60 &&
        decision.quota.remaining >= 0 &&
        decision.quota.remaining <= 4 &&
        decision.quota.resetAfterSeconds >= 1 &&
        decision.quota.resetAfterSeconds <= 60,
    ),
  ).toBe(true);

  const [bucket] = await database.db.select().from(rateLimitBuckets);
  expect(bucket?.requestCount).toBe(20);
  expect(bucket?.identityHash).toBe(digester.sha256Hex("http.global\0" + "203.0.113.10"));
  expect(JSON.stringify(bucket)).not.toContain(identity);
});

test("keeps scopes and client identities isolated", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 1,
    windowSeconds: 60,
  });

  expect(await limiter.consume({ scope: "http.global", identity: "198.51.100.10" })).toMatchObject({
    allowed: true,
  });
  expect(await limiter.consume({ scope: "http.global", identity: "198.51.100.11" })).toMatchObject({
    allowed: true,
  });
  expect(await limiter.consume({ scope: "users.write", identity: "198.51.100.10" })).toMatchObject({
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

  expect(await limiter.consume({ scope: "http.users.write", identity })).toMatchObject({
    allowed: true,
  });
  const writeDenied = await limiter.consume({ scope: "http.users.write", identity });
  expect(writeDenied.allowed).toBe(false);
  if (!writeDenied.allowed) {
    expect(writeDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(writeDenied.retryAfterSeconds).toBeLessThanOrEqual(10);
  }

  expect(await limiter.consume({ scope: "http.users.read", identity })).toMatchObject({ allowed: true });
  expect(await limiter.consume({ scope: "http.users.read", identity })).toMatchObject({ allowed: true });
  const readDenied = await limiter.consume({ scope: "http.users.read", identity });
  expect(readDenied.allowed).toBe(false);
  if (!readDenied.allowed) {
    expect(readDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(readDenied.retryAfterSeconds).toBeLessThanOrEqual(30);
  }

  for (let index = 0; index < 3; index += 1) {
    expect(await limiter.consume({ scope: "http.global", identity })).toMatchObject({ allowed: true });
  }
  const globalDenied = await limiter.consume({ scope: "http.global", identity });
  expect(globalDenied.allowed).toBe(false);
  if (!globalDenied.allowed) {
    expect(globalDenied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(globalDenied.retryAfterSeconds).toBeLessThanOrEqual(60);
  }
});

test("returns exact quota metadata for allowed and denied fixed-window decisions", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 2,
    windowSeconds: 30,
  });
  const request = { scope: "http.global", identity: "203.0.113.90" } as const;

  const first = await limiter.consume(request);
  expect(first.allowed).toBe(true);
  expect(first.quota).toMatchObject({
    policyId: "http.global",
    limit: 2,
    remaining: 1,
    windowSeconds: 30,
  });
  expect(first.quota?.resetAfterSeconds).toBeGreaterThanOrEqual(1);
  expect(first.quota?.resetAfterSeconds).toBeLessThanOrEqual(30);

  const second = await limiter.consume(request);
  expect(second.allowed).toBe(true);
  expect(second.quota).toMatchObject({
    policyId: "http.global",
    limit: 2,
    remaining: 0,
    windowSeconds: 30,
  });

  const denied = await limiter.consume(request);
  expect(denied.allowed).toBe(false);
  expect(denied.quota).toMatchObject({
    policyId: "http.global",
    limit: 2,
    remaining: 0,
    windowSeconds: 30,
  });
  if (!denied.allowed) {
    const quota = denied.quota;
    expect(quota).toBeDefined();
    if (quota === undefined) {
      throw new Error("PostgreSQL rate limiter must return quota metadata");
    }
    expect(denied.retryAfterSeconds).toBe(quota.resetAfterSeconds);
  }
});

test("quota reset metadata uses the database clock rather than the application clock", async () => {
  const dateNow = spyOn(Date, "now").mockReturnValue(0);
  try {
    const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
      limit: 1,
      windowSeconds: 30,
    });
    const request = {
      scope: "http.global",
      identity: `clock-skew-${crypto.randomUUID()}`,
    } as const;

    const allowed = await limiter.consume(request);
    expect(allowed.allowed).toBe(true);
    expect(allowed.quota?.resetAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(allowed.quota?.resetAfterSeconds).toBeLessThanOrEqual(30);

    const denied = await limiter.consume(request);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(30);
      expect(denied.quota?.resetAfterSeconds).toBe(denied.retryAfterSeconds);
    }
  } finally {
    dateNow.mockRestore();
  }
});

test("resets an expired bucket atomically instead of growing one row per window", async () => {
  const limiter = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 1,
    windowSeconds: 60,
  });
  const request = { scope: "http.global", identity: "192.0.2.25" } as const;

  expect(await limiter.consume(request)).toMatchObject({ allowed: true });
  const denied = await limiter.consume(request);
  expect(denied.allowed).toBe(false);
  if (!denied.allowed) {
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
  }

  const identityHash = digester.sha256Hex(`http.global\0${request.identity}`);
  await database.db
    .update(rateLimitBuckets)
    .set({ expiresAt: new Date(0) })
    .where(eq(rateLimitBuckets.identityHash, identityHash));

  expect(await limiter.consume(request)).toMatchObject({ allowed: true });

  const rows = await database.db
    .select()
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.identityHash, identityHash));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.requestCount).toBe(1);
  expect(rows[0]?.windowStartedAt.getTime()).toBeGreaterThan(0);
});

test("periodic hot-path cleanup deletes at most one bounded expired batch", async () => {
  const expiredRows = Array.from({ length: 1_005 }, (_, index) => ({
    scope: "http.global",
    identityHash: digester.sha256Hex(`http.global\\0expired-client-${index}`),
    windowStartedAt: new Date(0),
    requestCount: 99,
    expiresAt: new Date(0),
  }));
  await database.db.insert(rateLimitBuckets).values(expiredRows);

  const meter = new RecordingMeter();
  const rateLimitObserver = new RateLimitObserver({ meter });
  const limiter = new PostgresFixedWindowRateLimiter(
    database.db,
    digester,
    {
      limit: 10,
      windowSeconds: 60,
    },
    undefined,
    rateLimitObserver,
  );
  await limiter.consume({ scope: "http.global", identity: "203.0.113.44" });

  expect(meter.counters).toContainEqual({
    name: "rate_limit.cleanup.rows",
    value: 1_000,
    attributes: {
      "rate_limit.backend": "postgresql",
      "rate_limit.algorithm": "fixed_window",
    },
  });
  expect(meter.counters).toContainEqual({
    name: "rate_limit.cleanup.runs",
    value: 1,
    attributes: {
      "rate_limit.backend": "postgresql",
      "rate_limit.algorithm": "fixed_window",
      "rate_limit.cleanup.result": "success",
    },
  });

  const rows = await database.db.select().from(rateLimitBuckets);
  const expired = rows.filter((row) => row.expiresAt.getTime() === 0);
  expect(expired).toHaveLength(5);
  expect(rows).toHaveLength(6);
});

test("independent limiter instances split expired cleanup work with skip locked", async () => {
  const expiredRows = Array.from({ length: 1_500 }, (_, index) => ({
    scope: "http.global",
    identityHash: digester.sha256Hex(`http.global\\0parallel-expired-${index}`),
    windowStartedAt: new Date(0),
    requestCount: 99,
    expiresAt: new Date(0),
  }));
  await database.db.insert(rateLimitBuckets).values(expiredRows);

  const first = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 10,
    windowSeconds: 60,
  });
  const second = new PostgresFixedWindowRateLimiter(database.db, digester, {
    limit: 10,
    windowSeconds: 60,
  });

  await Promise.all([
    first.consume({ scope: "http.global", identity: "203.0.113.50" }),
    second.consume({ scope: "http.global", identity: "203.0.113.51" }),
  ]);

  const rows = await database.db.select().from(rateLimitBuckets);
  expect(rows.filter((row) => row.expiresAt.getTime() === 0)).toHaveLength(0);
  expect(rows).toHaveLength(2);
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
