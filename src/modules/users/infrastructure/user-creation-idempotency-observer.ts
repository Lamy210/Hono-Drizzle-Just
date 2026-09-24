import type { Meter } from "../../../core/observability/meter";

type CleanupResult = "success" | "error";

const CLEANUP_ATTRIBUTES = {
  "idempotency.backend": "postgresql",
  "idempotency.operation": "users.create",
} as const;

export class UserCreationIdempotencyObserver {
  constructor(private readonly meter: Meter) {}

  async cleanup(execute: () => Promise<number>): Promise<number> {
    let result: CleanupResult = "error";

    try {
      const deletedRows = await execute();
      result = "success";
      if (deletedRows > 0) {
        this.meter.increment(
          "idempotency.cleanup.rows",
          deletedRows,
          CLEANUP_ATTRIBUTES,
        );
      }
      return deletedRows;
    } finally {
      this.meter.increment("idempotency.cleanup.runs", 1, {
        ...CLEANUP_ATTRIBUTES,
        "idempotency.cleanup.result": result,
      });
    }
  }
}
