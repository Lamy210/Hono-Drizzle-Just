import type { Pool } from "pg";
import type { HealthCheck } from "../../core/health/health-check";

export class DatabaseHealthCheck implements HealthCheck {
  readonly name = "database";
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<void> {
    const databaseCheck = this.inFlight ?? this.startCheck();
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        databaseCheck,
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

  private startCheck(): Promise<void> {
    const query = Promise.resolve().then(async () => {
      await this.pool.query("select 1");
    });
    let tracked: Promise<void>;
    tracked = query.finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = tracked;
    return tracked;
  }
}
