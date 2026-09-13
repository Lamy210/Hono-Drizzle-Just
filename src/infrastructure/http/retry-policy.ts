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
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly maxRetries: number;

  constructor(options: DefaultRetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 1;
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

    const retryAfter = failure.headers?.get("retry-after");
    if (retryAfter !== null && retryAfter !== undefined && /^\d+$/.test(retryAfter.trim())) {
      return Number(retryAfter.trim()) * 1_000;
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
