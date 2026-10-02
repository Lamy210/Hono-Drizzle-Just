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

function snapshotDefaultRetryPolicyOptions(options: unknown): DefaultRetryPolicyOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("DefaultRetryPolicy options must be a non-array object");
  }

  try {
    const maxRetries = Reflect.get(
      options,
      "maxRetries",
    ) as DefaultRetryPolicyOptions["maxRetries"];
    const baseDelayMs = Reflect.get(
      options,
      "baseDelayMs",
    ) as DefaultRetryPolicyOptions["baseDelayMs"];
    const maxDelayMs = Reflect.get(
      options,
      "maxDelayMs",
    ) as DefaultRetryPolicyOptions["maxDelayMs"];
    const now = Reflect.get(options, "now") as DefaultRetryPolicyOptions["now"];
    const random = Reflect.get(options, "random") as DefaultRetryPolicyOptions["random"];

    return {
      ...(maxRetries === undefined ? {} : { maxRetries }),
      ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
      ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
      ...(now === undefined ? {} : { now }),
      ...(random === undefined ? {} : { random }),
    };
  } catch {
    throw new TypeError("DefaultRetryPolicy options could not be read");
  }
}

function requireNumberHook(name: "now" | "random", value: unknown): () => number {
  if (typeof value !== "function") {
    throw new TypeError("DefaultRetryPolicy " + name + " must be callable");
  }
  return value as () => number;
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: DefaultRetryPolicyOptions = {}) {
    const normalizedOptions = snapshotDefaultRetryPolicyOptions(options);
    this.maxRetries = nonNegativeInteger(
      "maxRetries",
      normalizedOptions.maxRetries === undefined ? 1 : normalizedOptions.maxRetries,
    );
    this.baseDelayMs = nonNegativeFiniteNumber(
      "baseDelayMs",
      normalizedOptions.baseDelayMs === undefined ? 100 : normalizedOptions.baseDelayMs,
    );
    this.maxDelayMs = nonNegativeFiniteNumber(
      "maxDelayMs",
      normalizedOptions.maxDelayMs === undefined ? 2_000 : normalizedOptions.maxDelayMs,
    );
    this.now =
      normalizedOptions.now === undefined
        ? Date.now
        : requireNumberHook("now", normalizedOptions.now);
    this.random =
      normalizedOptions.random === undefined
        ? Math.random
        : requireNumberHook("random", normalizedOptions.random);
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
      const seconds = Number(retryAfter);
      if (!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1_000) {
        return Number.MAX_SAFE_INTEGER;
      }
      return seconds * 1_000;
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
