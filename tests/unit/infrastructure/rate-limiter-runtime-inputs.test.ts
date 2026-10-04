import { expect, test } from "bun:test";
import type { StringDigester } from "../../../src/core/crypto/string-digester";
import type { RateLimitRequest } from "../../../src/core/rate-limit/rate-limiter";
import type { DatabaseSession } from "../../../src/infrastructure/database/database";
import { PostgresFixedWindowRateLimiter } from "../../../src/infrastructure/rate-limit/postgres-fixed-window-rate-limiter";
import { PostgresGcraRateLimiter } from "../../../src/infrastructure/rate-limit/postgres-gcra-rate-limiter";

const observedAt = "2026-10-04T00:00:00.000Z";
const expiresAt = new Date("2026-10-04T00:01:00.000Z");
const digester = {
  sha256Hex: () => "0".repeat(64),
} satisfies StringDigester;

function fixedWindowDatabase(): DatabaseSession {
  return {
    execute: async () => ({ rows: [{ deleted_count: "0" }] }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ requestCount: 1, expiresAt, observedAt }],
        }),
      }),
    }),
  } as unknown as DatabaseSession;
}

function gcraDatabase(): DatabaseSession {
  return {
    execute: async () => ({ rows: [{ deleted_count: "0" }] }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [{ theoreticalArrivalAt: expiresAt, observedAt }],
        }),
      }),
    }),
  } as unknown as DatabaseSession;
}

function limiters() {
  return [
    {
      name: "fixed-window",
      consume: (request: unknown) =>
        new PostgresFixedWindowRateLimiter(fixedWindowDatabase(), digester, {
          limit: 5,
          windowSeconds: 60,
        }).consume(request as RateLimitRequest),
    },
    {
      name: "gcra",
      consume: (request: unknown) =>
        new PostgresGcraRateLimiter(gcraDatabase(), digester, {
          limit: 5,
          windowSeconds: 60,
        }).consume(request as RateLimitRequest),
    },
  ] as const;
}

test("PostgreSQL rate limiters reject invalid runtime request containers", async () => {
  for (const { name, consume } of limiters()) {
    for (const request of [null, undefined, "request", 1, true, [], () => undefined]) {
      await expect(consume(request), `${name}: ${String(request)}`).rejects.toThrow(
        "Rate limit request must be a non-array object",
      );
    }
  }
});

test("PostgreSQL rate limiters reject non-string runtime request fields", async () => {
  for (const { consume } of limiters()) {
    await expect(consume({ scope: 123, identity: "203.0.113.10" })).rejects.toThrow(
      "Rate limit scope must be a normalized 1 to 100 character identifier",
    );
    await expect(consume({ scope: "http.global", identity: 123 })).rejects.toThrow(
      "Rate limit identity is invalid",
    );
  }
});

test("PostgreSQL rate limiters normalize throwing runtime request getters", async () => {
  const secret = "private-rate-limit-request-detail";

  for (const { consume } of limiters()) {
    const error = await consume({
      get scope(): string {
        throw new Error(`scope failed with ${secret}`);
      },
      identity: "203.0.113.10",
    }).then(
      () => new Error("consume unexpectedly succeeded"),
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: "Rate limit request could not be read" });
    expect(String(error)).not.toContain(secret);
  }
});

test("PostgreSQL rate limiters snapshot runtime request fields exactly once", async () => {
  for (const { consume } of limiters()) {
    const reads = { scope: 0, identity: 0 };
    const request = {
      get scope() {
        reads.scope += 1;
        if (reads.scope > 1) {
          throw new Error("scope was read more than once");
        }
        return "http.global";
      },
      get identity() {
        reads.identity += 1;
        if (reads.identity > 1) {
          throw new Error("identity was read more than once");
        }
        return "203.0.113.10";
      },
    };

    await expect(consume(request)).resolves.toMatchObject({ allowed: true });
    expect(reads).toEqual({ scope: 1, identity: 1 });
  }
});
