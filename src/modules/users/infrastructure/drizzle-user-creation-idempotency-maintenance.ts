import { sql } from "drizzle-orm";
import { userCreationIdempotency } from "../../../db/schema";
import type { Database } from "../../../infrastructure/database/database";
import type { DatabaseObserver } from "../../../infrastructure/database/database-observer";
import type { UserCreationIdempotencyMaintenance } from "../application/user-creation-idempotency-maintenance";
import type { UserCreationIdempotencyCleanupGate } from "./user-creation-idempotency-cleanup-gate";
import type { UserCreationIdempotencyObserver } from "./user-creation-idempotency-observer";

const CLEANUP_BATCH_SIZE = 1_000;

export class DrizzleUserCreationIdempotencyMaintenance
  implements UserCreationIdempotencyMaintenance
{
  constructor(
    private readonly database: Database,
    private readonly cleanupGate: UserCreationIdempotencyCleanupGate,
    private readonly databaseObserver?: DatabaseObserver,
    private readonly maintenanceObserver?: UserCreationIdempotencyObserver,
  ) {}

  async cleanupIfDue(): Promise<void> {
    if (!this.cleanupGate.acquireIfDue()) {
      return;
    }

    const cleanup = async (): Promise<number> => {
      const execute = () =>
        this.database.execute<{ deleted_count: string }>(sql`
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
          ),
          deleted as (
            delete from ${userCreationIdempotency}
            using expired
            where
              ${userCreationIdempotency.tenantId} = expired.tenant_id
              and ${userCreationIdempotency.keyHash} = expired.key_hash
              and ${userCreationIdempotency.expiresAt} <= now()
            returning 1
          )
          select count(*)::text as deleted_count
          from deleted
        `);
      const result = this.databaseObserver
        ? await this.databaseObserver.operation(
            { operation: "DELETE", collection: "user_creation_idempotency" },
            execute,
          )
        : await execute();

      const deletedCount = result.rows[0]?.deleted_count;
      if (deletedCount === undefined || !/^[0-9]+$/.test(deletedCount)) {
        throw new Error("Idempotency cleanup returned an invalid deleted row count");
      }
      const parsed = Number(deletedCount);
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > CLEANUP_BATCH_SIZE) {
        throw new Error("Idempotency cleanup returned an invalid deleted row count");
      }
      return parsed;
    };

    try {
      if (this.maintenanceObserver) {
        await this.maintenanceObserver.cleanup(cleanup);
      } else {
        await cleanup();
      }
    } catch {
      // Cleanup is retention maintenance, not part of idempotency correctness.
      // The observer records failures; the following business transaction remains independent.
    }
  }
}
