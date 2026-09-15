import type { HttpRequest } from "../../core/http/http-client";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function nonNegativeFiniteNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to 0`);
  }
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

export type RetryFailure =
  | { readonly kind: "response"; readonly status: number; readonly headers?: Headers }
  | { readonly kind: "network" };

export interface RetryPolicy {
  nextDelay(request: HttpRequest, failedAttempt: number, failure: RetryFailure): number | null;
}

export interface DefaultRetryPolicyOptions {
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: DefaultRetryPolicyOptions = {}) {
    this.maxRetries = nonNegativeInteger("maxRetries", options.maxRetries ?? 1);
    this.baseDelayMs = nonNegativeFiniteNumber("baseDelayMs", options.baseDelayMs ?? 100);
    this.maxDelayMs = nonNegativeFiniteNumber("maxDelayMs", options.maxDelayMs ?? 2_000);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  nextDelay(request: HttpRequest, failedAttempt: number, failure: RetryFailure): number | null {
    if (failedAttempt > this.maxRetries || !this.canRetryMethod(request)) {
      return null;
    }
    if (failure.kind === "response") {
      if (!RETRYABLE_STATUS_CODES.has(failure.status)) {
        return null;
      }

      const retryAfterDelay = this.parseRetryAfter(failure.headers?.get("retry-after"));
      if (retryAfterDelay !== null) {
        return retryAfterDelay;
      }
    }

    return this.backoffDelay(failedAttempt);
  }

  private parseRetryAfter(value: string | null | undefined): number | null {
    const retryAfter = value?.trim();
    if (!retryAfter) {
      return null;
    }
    if (/^\d+$/.test(retryAfter)) {
      return Number(retryAfter) * 1_000;
    }

    const retryAt = Date.parse(retryAfter);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - this.now()) : null;
  }

  private backoffDelay(failedAttempt: number): number {
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (failedAttempt - 1));
    const jitter = Math.min(1, Math.max(0, this.random()));
    return Math.floor(cap * jitter);
  }

  private canRetryMethod(request: HttpRequest): boolean {
    if (request.retry === "never") {
      return false;
    }
    return request.retry === "idempotent" || DEFAULT_RETRY_METHODS.has(request.method);
  }
}
