import type { HttpRequest } from "../../core/http/http-client";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RetryFailure =
  | { readonly kind: "response"; readonly status: number; readonly headers?: Headers }
  | { readonly kind: "network" };

export interface RetryPolicy {
  nextDelay(request: HttpRequest, failedAttempt: number, failure: RetryFailure): number | null;
}

export interface DefaultRetryPolicyOptions {
  readonly maxRetries?: number;
  readonly now?: () => number;
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly maxRetries: number;
  private readonly now: () => number;

  constructor(options: DefaultRetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 1;
    this.now = options.now ?? Date.now;
  }

  nextDelay(request: HttpRequest, failedAttempt: number, failure: RetryFailure): number | null {
    if (failedAttempt > this.maxRetries || !this.canRetryMethod(request)) {
      return null;
    }
    if (failure.kind === "network") {
      return 0;
    }
    if (!RETRYABLE_STATUS_CODES.has(failure.status)) {
      return null;
    }

    const retryAfter = failure.headers?.get("retry-after")?.trim();
    if (retryAfter && /^\d+$/.test(retryAfter)) {
      return Number(retryAfter) * 1_000;
    }
    if (retryAfter) {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) {
        return Math.max(0, retryAt - this.now());
      }
    }

    return 0;
  }

  private canRetryMethod(request: HttpRequest): boolean {
    if (request.retry === "never") {
      return false;
    }
    return request.retry === "idempotent" || DEFAULT_RETRY_METHODS.has(request.method);
  }
}
