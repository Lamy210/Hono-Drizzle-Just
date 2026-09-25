import { and, eq, lte, sql } from "drizzle-orm";
import type { StringDigester } from "../../core/crypto/string-digester";
import type {
  RateLimitDecision,
  RateLimiter,
  RateLimitRequest,
} from "../../core/rate-limit/rate-limiter";
import { rateLimitGcraBuckets } from "../../db/schema";
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

export interface GcraRateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface PostgresGcraRateLimiterOptions extends GcraRateLimitPolicy {
  readonly policies?: Readonly<Record<string, GcraRateLimitPolicy>>;
}

interface GcraState {
  readonly theoreticalArrivalAt: Date;
  readonly observedAt: string;
}

export class PostgresGcraRateLimiter implements RateLimiter {
  private readonly defaultPolicy: GcraRateLimitPolicy;
  private readonly policies: Readonly<Record<string, GcraRateLimitPolicy>>;
  private readonly cleanupIntervalMs: number;
  private nextCleanupAt = 0;

  constructor(
    private readonly db: DatabaseSession,
    private readonly digester: StringDigester,
    options: PostgresGcraRateLimiterOptions,
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
    const execute = () => this.consumeGcra(request);
    return this.rateLimitObserver
      ? this.rateLimitObserver.decision({ backend: "postgresql", algorithm: "gcra" }, execute)
      : execute();
  }

  private async consumeGcra(request: RateLimitRequest): Promise<RateLimitDecision> {
    this.validateRequest(request);
    await this.cleanupExpiredIfDue();

    const policy = this.policies[request.scope] ?? this.defaultPolicy;
    const identityHash = this.digester.sha256Hex(`${request.scope}\0${request.identity}`);
    const emissionIntervalSeconds = policy.windowSeconds / policy.limit;
    const burstToleranceSeconds = emissionIntervalSeconds * (policy.limit - 1);
    const emissionInterval = sql`make_interval(secs => ${emissionIntervalSeconds})`;
    const burstTolerance = sql`make_interval(secs => ${burstToleranceSeconds})`;

    const initialTat = sql`clock_timestamp() + ${emissionInterval}`;
    const inserted = await this.observe("INSERT", () =>
      this.db
        .insert(rateLimitGcraBuckets)
        .values({
          scope: request.scope,
          identityHash,
          theoreticalArrivalAt: initialTat,
          expiresAt: initialTat,
        })
        .onConflictDoNothing({
          target: [rateLimitGcraBuckets.scope, rateLimitGcraBuckets.identityHash],
        })
        .returning({
          theoreticalArrivalAt: rateLimitGcraBuckets.theoreticalArrivalAt,
          observedAt: sql<string>`clock_timestamp()::text`,
        }),
    );

    const created = inserted[0];
    if (created) {
      return this.allowedDecision(request.scope, policy, created);
    }

    const nextTat = sql`greatest(${rateLimitGcraBuckets.theoreticalArrivalAt}, clock_timestamp()) + ${emissionInterval}`;
    const updated = await this.observe("UPDATE", () =>
      this.db
        .update(rateLimitGcraBuckets)
        .set({
          theoreticalArrivalAt: nextTat,
          expiresAt: nextTat,
        })
        .where(
          and(
            eq(rateLimitGcraBuckets.scope, request.scope),
            eq(rateLimitGcraBuckets.identityHash, identityHash),
            lte(
              rateLimitGcraBuckets.theoreticalArrivalAt,
              sql`clock_timestamp() + ${burstTolerance}`,
            ),
          ),
        )
        .returning({
          theoreticalArrivalAt: rateLimitGcraBuckets.theoreticalArrivalAt,
          observedAt: sql<string>`clock_timestamp()::text`,
        }),
    );

    const accepted = updated[0];
    if (accepted) {
      return this.allowedDecision(request.scope, policy, accepted);
    }

    const currentRows = await this.observe("SELECT", () =>
      this.db
        .select({
          theoreticalArrivalAt: rateLimitGcraBuckets.theoreticalArrivalAt,
          observedAt: sql<string>`clock_timestamp()::text`,
        })
        .from(rateLimitGcraBuckets)
        .where(
          and(
            eq(rateLimitGcraBuckets.scope, request.scope),
            eq(rateLimitGcraBuckets.identityHash, identityHash),
          ),
        )
        .limit(1),
    );
    const current = currentRows[0];
    if (!current) {
      throw new Error("GCRA rate limiter state disappeared during consume");
    }

    const debtMs = Math.max(
      0,
      current.theoreticalArrivalAt.getTime() - databaseTimestampMs(current.observedAt),
    );
    const toleranceMs = burstToleranceSeconds * 1_000;

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((debtMs - toleranceMs) / 1_000)),
      quota: {
        policyId: request.scope,
        limit: policy.limit,
        remaining: 0,
        windowSeconds: policy.windowSeconds,
        resetAfterSeconds: Math.max(1, Math.ceil(debtMs / 1_000)),
      },
    };
  }

  private allowedDecision(
    policyId: string,
    policy: GcraRateLimitPolicy,
    state: GcraState,
  ): RateLimitDecision {
    const intervalMs = (policy.windowSeconds * 1_000) / policy.limit;
    const toleranceMs = intervalMs * (policy.limit - 1);
    const debtMs = Math.max(
      0,
      state.theoreticalArrivalAt.getTime() - databaseTimestampMs(state.observedAt),
    );
    const remaining = Math.max(
      0,
      Math.min(policy.limit, Math.floor((toleranceMs - debtMs) / intervalMs) + 1),
    );

    return {
      allowed: true,
      quota: {
        policyId,
        limit: policy.limit,
        remaining,
        windowSeconds: policy.windowSeconds,
        resetAfterSeconds: Math.max(1, Math.ceil(debtMs / 1_000)),
      },
    };
  }

  private validatePolicy(scope: string, policy: GcraRateLimitPolicy): void {
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
              ${rateLimitGcraBuckets.scope},
              ${rateLimitGcraBuckets.identityHash}
            from ${rateLimitGcraBuckets}
            where ${rateLimitGcraBuckets.expiresAt} <= now()
            order by
              ${rateLimitGcraBuckets.expiresAt},
              ${rateLimitGcraBuckets.scope},
              ${rateLimitGcraBuckets.identityHash}
            limit ${CLEANUP_BATCH_SIZE}
            for update skip locked
          ),
          deleted as (
            delete from ${rateLimitGcraBuckets}
            using expired
            where
              ${rateLimitGcraBuckets.scope} = expired.scope
              and ${rateLimitGcraBuckets.identityHash} = expired.identity_hash
              and ${rateLimitGcraBuckets.expiresAt} <= now()
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
          { backend: "postgresql", algorithm: "gcra" },
          cleanup,
        );
      } else {
        await cleanup();
      }
    } catch {
      // Expired-bucket cleanup is retention maintenance. Quota enforcement remains authoritative.
    }
  }

  private observe<T>(
    operation: "DELETE" | "INSERT" | "SELECT" | "UPDATE",
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.observer
      ? this.observer.operation({ operation, collection: "rate_limit_gcra_buckets" }, execute)
      : execute();
  }
}
