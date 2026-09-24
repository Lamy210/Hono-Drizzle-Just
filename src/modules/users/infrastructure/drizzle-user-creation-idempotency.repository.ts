import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { AppError } from "../../../core/errors/app-error";
import { userCreationIdempotency } from "../../../db/schema";
import type { DatabaseSession } from "../../../infrastructure/database/database";
import type { DatabaseObserver } from "../../../infrastructure/database/database-observer";
import type { UserCreationIdempotencyCleanupGate } from "./user-creation-idempotency-cleanup-gate";
import type {
  UserCreationIdempotencyClaim,
  UserCreationIdempotencyRepository,
} from "../application/user-creation-idempotency.repository";

type DatabaseOperation = "DELETE" | "SELECT" | "INSERT" | "UPDATE";

const CLEANUP_BATCH_SIZE = 1_000;

export class DrizzleUserCreationIdempotencyRepository
  implements UserCreationIdempotencyRepository
{
  constructor(
    private readonly db: DatabaseSession,
    private readonly observer?: DatabaseObserver,
    private readonly cleanupGate?: UserCreationIdempotencyCleanupGate,
  ) {}

  async claim(input: {
    readonly tenantId: string;
    readonly keyHash: string;
    readonly requestFingerprint: string;
    readonly ttlSeconds: number;
  }): Promise<UserCreationIdempotencyClaim> {
    await this.cleanupExpiredIfDue();
    const expiresAt = sql`now() + make_interval(secs => ${input.ttlSeconds})`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reclaimed = await this.observe("UPDATE", async () =>
        this.db
          .update(userCreationIdempotency)
          .set({
            requestFingerprint: input.requestFingerprint,
            userId: null,
            claimedAt: sql`now()`,
            expiresAt,
          })
          .where(
            and(
              eq(userCreationIdempotency.tenantId, input.tenantId),
              eq(userCreationIdempotency.keyHash, input.keyHash),
              lte(userCreationIdempotency.expiresAt, sql`now()`),
            ),
          )
          .returning({ keyHash: userCreationIdempotency.keyHash }),
      );
      if (reclaimed.length === 1) {
        return { state: "claimed" };
      }

      const inserted = await this.observe("INSERT", async () =>
        this.db
          .insert(userCreationIdempotency)
          .values({
            tenantId: input.tenantId,
            keyHash: input.keyHash,
            requestFingerprint: input.requestFingerprint,
            userId: null,
            claimedAt: sql`now()`,
            expiresAt,
          })
          .onConflictDoNothing({
            target: [userCreationIdempotency.tenantId, userCreationIdempotency.keyHash],
          })
          .returning({ keyHash: userCreationIdempotency.keyHash }),
      );
      if (inserted.length === 1) {
        return { state: "claimed" };
      }

      const existing = await this.observe("SELECT", async () =>
        this.db
          .select({
            requestFingerprint: userCreationIdempotency.requestFingerprint,
            userId: userCreationIdempotency.userId,
          })
          .from(userCreationIdempotency)
          .where(
            and(
              eq(userCreationIdempotency.tenantId, input.tenantId),
              eq(userCreationIdempotency.keyHash, input.keyHash),
              gt(userCreationIdempotency.expiresAt, sql`now()`),
            ),
          )
          .limit(1),
      );
      const record = existing[0];
      if (record) {
        return { state: "existing", record };
      }
    }

    throw new AppError("INTERNAL_ERROR", "Idempotency state is inconsistent", 500);
  }

  async complete(input: {
    readonly tenantId: string;
    readonly keyHash: string;
    readonly requestFingerprint: string;
    readonly userId: string;
  }): Promise<void> {
    const updated = await this.observe("UPDATE", async () =>
      this.db
        .update(userCreationIdempotency)
        .set({ userId: input.userId })
        .where(
          and(
            eq(userCreationIdempotency.tenantId, input.tenantId),
            eq(userCreationIdempotency.keyHash, input.keyHash),
            eq(userCreationIdempotency.requestFingerprint, input.requestFingerprint),
            isNull(userCreationIdempotency.userId),
          ),
        )
        .returning({ keyHash: userCreationIdempotency.keyHash }),
    );

    if (updated.length !== 1) {
      throw new AppError("INTERNAL_ERROR", "Idempotency state is inconsistent", 500);
    }
  }

  private async cleanupExpiredIfDue(): Promise<void> {
    if (!this.cleanupGate?.acquireIfDue()) {
      return;
    }

    await this.observe("DELETE", () =>
      this.db.execute(sql`
        with expired as (
          select
            ${userCreationIdempotency.tenantId},
            ${userCreationIdempotency.keyHash}
          from ${userCreationIdempotency}
          where ${userCreationIdempotency.expiresAt} <= now()
          order by
            ${userCreationIdempotency.expiresAt},
            ${userCreationIdempotency.tenantId},
            ${userCreationIdempotency.keyHash}
          limit ${CLEANUP_BATCH_SIZE}
          for update skip locked
        )
        delete from ${userCreationIdempotency}
        using expired
        where
          ${userCreationIdempotency.tenantId} = expired.tenant_id
          and ${userCreationIdempotency.keyHash} = expired.key_hash
          and ${userCreationIdempotency.expiresAt} <= now()
      `),
    );
  }

  private observe<T>(operation: DatabaseOperation, execute: () => Promise<T>): Promise<T> {
    return this.observer
      ? this.observer.operation(
          { operation, collection: "user_creation_idempotency" },
          execute,
        )
      : execute();
  }
}
