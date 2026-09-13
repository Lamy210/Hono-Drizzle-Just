import type { HealthCheck, HealthCheckOutcome, ReadinessResult } from "./health-check";

export class ReadinessChecker {
  constructor(private readonly healthChecks: readonly HealthCheck[]) {}

  async check(): Promise<ReadinessResult> {
    const entries = await Promise.all(
      this.healthChecks.map(async (healthCheck): Promise<readonly [string, HealthCheckOutcome]> => {
        const startedAt = performance.now();
        try {
          await healthCheck.check();
          return [
            healthCheck.name,
            { status: "up", durationMs: this.durationSince(startedAt) },
          ] as const;
        } catch {
          return [
            healthCheck.name,
            { status: "down", durationMs: this.durationSince(startedAt) },
          ] as const;
        }
      }),
    );

    const checks: Record<string, HealthCheckOutcome> = Object.fromEntries(entries);
    const ready = Object.values(checks).every((check) => check.status === "up");
    return { status: ready ? "ready" : "not_ready", checks };
  }

  private durationSince(startedAt: number): number {
    return Number((performance.now() - startedAt).toFixed(2));
  }
}
