const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export class UserCreationIdempotencyCleanupGate {
  private nextCleanupAt = 0;

  constructor(
    private readonly intervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 3_600_000) {
      throw new RangeError("Idempotency cleanup interval must be an integer between 1 and 3600000 ms");
    }
  }

  acquireIfDue(): boolean {
    const current = this.now();
    if (!Number.isFinite(current)) {
      throw new TypeError("Idempotency cleanup clock returned a non-finite timestamp");
    }
    if (current < this.nextCleanupAt) {
      return false;
    }

    this.nextCleanupAt = current + this.intervalMs;
    return true;
  }
}
