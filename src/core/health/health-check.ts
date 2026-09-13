export interface HealthCheck {
  readonly name: string;
  check(): Promise<void>;
}

export interface HealthCheckOutcome {
  readonly status: "up" | "down";
  readonly durationMs: number;
}

export interface ReadinessResult {
  readonly status: "ready" | "not_ready";
  readonly checks: Readonly<Record<string, HealthCheckOutcome>>;
}
