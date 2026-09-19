import { lte, sql } from "drizzle-orm";
import type { StringDigester } from "../../core/crypto/string-digester";
import type {
  RateLimitDecision,
  RateLimiter,
  RateLimitRequest,
} from "../../core/rate-limit/rate-limiter";
import { rateLimitBuckets } from "../../db/schema";
import type { DatabaseSession } from "../database/database";
import type { DatabaseObserver } from "../database/database-observer";
import type { RateLimitObserver } from "./rate-limit-observer";

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const MAX_IDENTITY_LENGTH = 512;
const MIN_CLEANUP_INTERVAL_MS = 60_000;
const MAX_CLEANUP_INTERVAL_MS = 300_000;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface PostgresFixedWindowRateLimiterOptions {
  readonly limit: number;
  readonly windowSeconds: number;
}

export class PostgresFixedWindowRateLimiter implements RateLimiter {
  private readonly limit: number;
  private readonly windowSeconds: number;
  private readonly cleanupIntervalMs: number;
  private nextCleanupAt = 0;

  constructor(
    private readonly db: DatabaseSession,
    private readonly digester: StringDigester,
    options: PostgresFixedWindowRateLimiterOptions,
    private readonly observer?: DatabaseObserver,
    private readonly rateLimitObserver?: RateLimitObserver,
  ) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new TypeError("Rate limit must be a positive integer");
    }
    if (
      !Number.isInteger(options.windowSeconds) ||
      options.windowSeconds < 1 ||
      options.windowSeconds > 86_400
    ) {
      throw new TypeError("Rate limit window must be an integer between 1 and 86400 seconds");
    }

    this.limit = options.limit;
    this.windowSeconds = options.windowSeconds;
    this.cleanupIntervalMs = Math.min(
      MAX_CLEANUP_INTERVAL_MS,
      Math.max(MIN_CLEANUP_INTERVAL_MS, options.windowSeconds * 1_000),
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

    const identityHash = this.digester.sha256Hex(`${request.scope}\0${request.identity}`);
    const expiresAt = sql`now() + make_interval(secs => ${this.windowSeconds})`;
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
        }),
    );

    const bucket = rows[0];
    if (!bucket) {
      throw new Error("Rate limiter upsert returned no row");
    }
    if (bucket.requestCount <= this.limit) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.expiresAt.getTime() - Date.now()) / 1_000),
      ),
    };
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
    await this.observe("DELETE", () =>
      this.db.delete(rateLimitBuckets).where(lte(rateLimitBuckets.expiresAt, sql`now()`)),
    );
  }

  private observe<T>(operation: "DELETE" | "INSERT", execute: () => Promise<T>): Promise<T> {
    return this.observer
      ? this.observer.operation({ operation, collection: "rate_limit_buckets" }, execute)
      : execute();
  }
}
