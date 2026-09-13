import type { Pool } from "pg";
import type { HealthCheck } from "../../core/health/health-check";

export class DatabaseHealthCheck implements HealthCheck {
  readonly name = "database";

  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pool.query("select 1"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("database readiness check timed out")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
