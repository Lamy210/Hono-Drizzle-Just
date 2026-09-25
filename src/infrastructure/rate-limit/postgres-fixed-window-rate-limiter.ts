import { sql } from "drizzle-orm";
import type { StringDigester } from "../../core/crypto/string-digester";
import type {
  RateLimitDecision,
  RateLimiter,
  RateLimitRequest,
} from "../../core/rate-limit/rate-limiter";
import { rateLimitBuckets } from "../../db/schema";
import type { DatabaseSession } from "../database/database";
import type { DatabaseObserver } from "../database/database-observer";
import { databaseTimestampMs } from "./database-time";
import type { RateLimitObserver } from "./rate-limit-observer";

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const MAX_IDENTITY_LENGTH = 512;
const MIN_CLEANUP_INTERVAL_MS = 60_000;
const MAX_CLEANUP_INTERVAL_MS = 300_000;
const CLEANUP_BATCH_SIZE = 1_000;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface FixedWindowRateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface PostgresFixedWindowRateLimiterOptions extends FixedWindowRateLimitPolicy {
  readonly policies?: Readonly<Record<string, FixedWindowRateLimitPolicy>>;
}

export class PostgresFixedWindowRateLimiter implements RateLimiter {
  private readonly defaultPolicy: FixedWindowRateLimitPolicy;
  private readonly policies: Readonly<Record<string, FixedWindowRateLimitPolicy>>;
  private readonly cleanupIntervalMs: number;
  private nextCleanupAt = 0;

  constructor(
    private readonly db: DatabaseSession,
    private readonly digester: StringDigester,
    options: PostgresFixedWindowRateLimiterOptions,
    private readonly observer?: DatabaseObserver,
    private readonly rateLimitObserver?: RateLimitObserver,
  ) {
    this.validatePolicy("default", options);
    for (const [scope, policy] of Object.entries(options.policies ?? {})) {
      if (!SCOPE_PATTERN.test(scope)) {
        throw new TypeError("Rate limit policy scope is invalid");
      }
      this.validatePolicy(scope, policy);
    }

    this.defaultPolicy = {
      limit: options.limit,
      windowSeconds: options.windowSeconds,
    };
    this.policies = options.policies ?? {};
    const shortestWindowSeconds = Math.min(
      this.defaultPolicy.windowSeconds,
      ...Object.values(this.policies).map((policy) => policy.windowSeconds),
    );
    this.cleanupIntervalMs = Math.min(
      MAX_CLEANUP_INTERVAL_MS,
      Math.max(MIN_CLEANUP_INTERVAL_MS, shortestWindowSeconds * 1_000),
    );
  }

  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const execute = () => this.consumeFixedWindow(request);
    return this.rateLimitObserver
      ? this.rateLimitObserver.decision(
          { backend: "postgresql", algorithm: "fixed_window" },
          execute,
        )
      : execute();
  }

  private async consumeFixedWindow(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.validateRequest(request);
    await this.cleanupExpiredIfDue();

    const policy = this.policies[request.scope] ?? this.defaultPolicy;
    const identityHash = this.digester.sha256Hex(`${request.scope}\0${request.identity}`);
    const expiresAt = sql`now() + make_interval(secs => ${policy.windowSeconds})`;
    const expired = sql`${rateLimitBuckets.expiresAt} <= now()`;

    const rows = await this.observe("INSERT", async () =>
      this.db
        .insert(rateLimitBuckets)
        .values({
          scope: request.scope,
          identityHash,
          windowStartedAt: sql`now()`,
          requestCount: 1,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [rateLimitBuckets.scope, rateLimitBuckets.identityHash],
          set: {
            requestCount: sql`case when ${expired} then 1 else ${rateLimitBuckets.requestCount} + 1 end`,
            windowStartedAt: sql`case when ${expired} then now() else ${rateLimitBuckets.windowStartedAt} end`,
            expiresAt: sql`case when ${expired} then ${expiresAt} else ${rateLimitBuckets.expiresAt} end`,
          },
        })
        .returning({
          requestCount: rateLimitBuckets.requestCount,
          expiresAt: rateLimitBuckets.expiresAt,
          observedAt: sql<string>`clock_timestamp()::text`,
        }),
    );

    const bucket = rows[0];
    if (!bucket) {
      throw new Error("Rate limiter upsert returned no row");
    }

    const resetAfterSeconds = Math.max(
      1,
      Math.ceil(
        (bucket.expiresAt.getTime() - databaseTimestampMs(bucket.observedAt)) / 1_000,
      ),
    );
    const quota = {
      policyId: request.scope,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - bucket.requestCount),
      windowSeconds: policy.windowSeconds,
      resetAfterSeconds,
    } as const;

    if (bucket.requestCount <= policy.limit) {
      return { allowed: true, quota };
    }

    return {
      allowed: false,
      retryAfterSeconds: resetAfterSeconds,
      quota,
    };
  }

  private validatePolicy(scope: string, policy: FixedWindowRateLimitPolicy): void {
    if (!Number.isInteger(policy.limit) || policy.limit < 1 || policy.limit > 1_000_000) {
      throw new TypeError(`Rate limit for ${scope} must be an integer between 1 and 1000000`);
    }
    if (
      !Number.isInteger(policy.windowSeconds) ||
      policy.windowSeconds < 1 ||
      policy.windowSeconds > 86_400
    ) {
      throw new TypeError(
        `Rate limit window for ${scope} must be an integer between 1 and 86400 seconds`,
      );
    }
  }

  private validateRequest(request: RateLimitRequest): void {
    if (!SCOPE_PATTERN.test(request.scope)) {
      throw new TypeError("Rate limit scope must be a normalized 1 to 100 character identifier");
    }
    if (
      request.identity.length < 1 ||
      request.identity.length > MAX_IDENTITY_LENGTH ||
      hasControlCharacters(request.identity)
    ) {
      throw new TypeError("Rate limit identity is invalid");
    }
  }

  private async cleanupExpiredIfDue(): Promise<void> {
    const now = Date.now();
    if (now < this.nextCleanupAt) {
      return;
    }

    this.nextCleanupAt = now + this.cleanupIntervalMs;

    const cleanup = async (): Promise<number> => {
      const result = await this.observe("DELETE", () =>
        this.db.execute<{ deleted_count: string }>(sql`
          with expired as (
            select
              ${rateLimitBuckets.scope},
              ${rateLimitBuckets.identityHash}
            from ${rateLimitBuckets}
            where ${rateLimitBuckets.expiresAt} <= now()
            order by
              ${rateLimitBuckets.expiresAt},
              ${rateLimitBuckets.scope},
              ${rateLimitBuckets.identityHash}
            limit ${CLEANUP_BATCH_SIZE}
            for update skip locked
          ),
          deleted as (
            delete from ${rateLimitBuckets}
            using expired
            where
              ${rateLimitBuckets.scope} = expired.scope
              and ${rateLimitBuckets.identityHash} = expired.identity_hash
              and ${rateLimitBuckets.expiresAt} <= now()
            returning 1
          )
          select count(*)::text as deleted_count
          from deleted
        `),
      );

      const deletedCount = result.rows[0]?.deleted_count;
      if (deletedCount === undefined || !/^[0-9]+$/.test(deletedCount)) {
        throw new Error("Rate-limit cleanup returned an invalid deleted row count");
      }
      const parsed = Number(deletedCount);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > CLEANUP_BATCH_SIZE) {
        throw new Error("Rate-limit cleanup returned an invalid deleted row count");
      }
      return parsed;
    };

    try {
      if (this.rateLimitObserver) {
        await this.rateLimitObserver.cleanup(
          { backend: "postgresql", algorithm: "fixed_window" },
          cleanup,
        );
      } else {
        await cleanup();
      }
    } catch {
      // Expired-bucket cleanup is retention maintenance. Quota enforcement remains authoritative.
    }
  }

  private observe<T>(operation: "DELETE" | "INSERT", execute: () => Promise<T>): Promise<T> {
    return this.observer
      ? this.observer.operation({ operation, collection: "rate_limit_buckets" }, execute)
      : execute();
  }
}
