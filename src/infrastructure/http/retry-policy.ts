import type { HttpRequest } from "../../core/http/http-client";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type RetryFailure =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "network" };

export interface RetryPolicy {
  shouldRetry(request: HttpRequest, failedAttempt: number, failure: RetryFailure): boolean;
}

export interface DefaultRetryPolicyOptions {
  readonly maxRetries?: number;
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly maxRetries: number;

  constructor(options: DefaultRetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 1;
  }

  shouldRetry(request: HttpRequest, failedAttempt: number, failure: RetryFailure): boolean {
    if (failedAttempt > this.maxRetries || !this.canRetryMethod(request)) {
      return false;
    }
    if (failure.kind === "network") {
      return true;
    }
    return RETRYABLE_STATUS_CODES.has(failure.status);
  }

  private canRetryMethod(request: HttpRequest): boolean {
    return request.retry === "idempotent" || DEFAULT_RETRY_METHODS.has(request.method);
  }
}
