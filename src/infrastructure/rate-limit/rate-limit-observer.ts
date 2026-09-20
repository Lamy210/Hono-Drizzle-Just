import type { Meter } from "../../core/observability/meter";
import type { RateLimitDecision } from "../../core/rate-limit/rate-limiter";

export type RateLimitNow = () => number;

export interface RateLimitObservationDescriptor {
  readonly backend: "postgresql";
  readonly algorithm: "fixed_window" | "gcra";
}

export interface RateLimitObserverOptions {
  readonly meter: Meter;
  readonly now?: RateLimitNow;
}

type RateLimitResult = "allowed" | "denied" | "error";

export class RateLimitObserver {
  private readonly now: RateLimitNow;

  constructor(private readonly options: RateLimitObserverOptions) {
    this.now = options.now ?? performance.now.bind(performance);
  }

  async decision(
    descriptor: RateLimitObservationDescriptor,
    execute: () => Promise<RateLimitDecision>,
  ): Promise<RateLimitDecision> {
    const startedAt = this.now();
    let result: RateLimitResult = "error";

    try {
      const decision = await execute();
      result = decision.allowed ? "allowed" : "denied";
      return decision;
    } finally {
      const attributes = {
        "rate_limit.backend": descriptor.backend,
        "rate_limit.algorithm": descriptor.algorithm,
        "rate_limit.result": result,
      } as const;

      this.options.meter.increment("rate_limit.decisions", 1, attributes);
      this.options.meter.record(
        "rate_limit.decision.duration",
        Math.max(0, this.now() - startedAt) / 1_000,
        attributes,
      );
    }
  }
}
