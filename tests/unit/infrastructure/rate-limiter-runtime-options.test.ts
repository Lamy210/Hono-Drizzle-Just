import { expect, test } from "bun:test";
import type { StringDigester } from "../../../src/core/crypto/string-digester";
import type { DatabaseSession } from "../../../src/infrastructure/database/database";
import {
  PostgresFixedWindowRateLimiter,
  type PostgresFixedWindowRateLimiterOptions,
} from "../../../src/infrastructure/rate-limit/postgres-fixed-window-rate-limiter";
import {
  PostgresGcraRateLimiter,
  type PostgresGcraRateLimiterOptions,
} from "../../../src/infrastructure/rate-limit/postgres-gcra-rate-limiter";

const database = {} as DatabaseSession;
const digester = {
  sha256Hex: () => "0".repeat(64),
} satisfies StringDigester;

const constructors = [
  {
    name: "fixed-window",
    create: (options: unknown) =>
      new PostgresFixedWindowRateLimiter(
        database,
        digester,
        options as PostgresFixedWindowRateLimiterOptions,
      ),
  },
  {
    name: "gcra",
    create: (options: unknown) =>
      new PostgresGcraRateLimiter(database, digester, options as PostgresGcraRateLimiterOptions),
  },
] as const;

test("PostgreSQL rate limiter constructors reject invalid runtime policy option containers", () => {
  for (const { name, create } of constructors) {
    for (const options of [null, "options", 1, true, [], () => undefined]) {
      expect(() => create(options), `${name}: ${String(options)}`).toThrow(
        "Rate limiter options must be a non-array object",
      );
    }
  }
});

test("PostgreSQL rate limiter constructors normalize throwing policy option getters", () => {
  const secret = "private-rate-limit-option-detail";

  for (const { create } of constructors) {
    const options = {
      limit: 5,
      windowSeconds: 60,
      get policies(): never {
        throw new Error(`policies failed with ${secret}`);
      },
    };

    const error = (() => {
      try {
        create(options);
        throw new Error("constructor unexpectedly succeeded");
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: "Rate limiter options could not be read" });
    expect(String(error)).not.toContain(secret);
  }
});

test("PostgreSQL rate limiter constructors snapshot policy fields exactly once", () => {
  for (const { create } of constructors) {
    const reads = {
      limit: 0,
      windowSeconds: 0,
      policies: 0,
      nestedLimit: 0,
      nestedWindowSeconds: 0,
    };

    const nestedPolicy = {
      get limit() {
        reads.nestedLimit += 1;
        if (reads.nestedLimit > 1) {
          throw new Error("nested limit was read more than once");
        }
        return 2;
      },
      get windowSeconds() {
        reads.nestedWindowSeconds += 1;
        if (reads.nestedWindowSeconds > 1) {
          throw new Error("nested windowSeconds was read more than once");
        }
        return 30;
      },
    };

    const options = {
      get limit() {
        reads.limit += 1;
        if (reads.limit > 1) {
          throw new Error("limit was read more than once");
        }
        return 5;
      },
      get windowSeconds() {
        reads.windowSeconds += 1;
        if (reads.windowSeconds > 1) {
          throw new Error("windowSeconds was read more than once");
        }
        return 60;
      },
      get policies() {
        reads.policies += 1;
        if (reads.policies > 1) {
          throw new Error("policies was read more than once");
        }
        return { "http.users.read": nestedPolicy };
      },
    };

    expect(() => create(options)).not.toThrow();
    expect(reads).toEqual({
      limit: 1,
      windowSeconds: 1,
      policies: 1,
      nestedLimit: 1,
      nestedWindowSeconds: 1,
    });
  }
});
