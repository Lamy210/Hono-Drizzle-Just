import type { HttpRequest } from "../../core/http/http-client";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const HTTP_METHODS = new Set<HttpRequest["method"]>([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type RetryRequest = Pick<HttpRequest, "method" | "retry">;
type RetryFailureSnapshot =
  | { readonly kind: "network" }
  | { readonly kind: "response"; readonly status: number; readonly source: object };

function nonNegativeFiniteNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to 0`);
  }
  return value;
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
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
  if (typeof options !== "object" || options === null) {
    throw new TypeError("DefaultRetryPolicy options must be a non-array object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(options);
  } catch {
    throw new TypeError("DefaultRetryPolicy options could not be read");
  }
  if (isArray) {
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

function snapshotRetryRequest(request: unknown): RetryRequest {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("DefaultRetryPolicy request must be a non-array object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(request);
  } catch {
    throw new TypeError("DefaultRetryPolicy request could not be read");
  }
  if (isArray) {
    throw new TypeError("DefaultRetryPolicy request must be a non-array object");
  }

  let method: unknown;
  let retry: unknown;
  try {
    method = Reflect.get(request, "method");
    retry = Reflect.get(request, "retry");
  } catch {
    throw new TypeError("DefaultRetryPolicy request could not be read");
  }

  if (typeof method !== "string" || !HTTP_METHODS.has(method as HttpRequest["method"])) {
    throw new TypeError("DefaultRetryPolicy request method was invalid");
  }
  if (retry !== undefined && retry !== "never" && retry !== "idempotent") {
    throw new TypeError("DefaultRetryPolicy request retry mode was invalid");
  }

  return {
    method: method as HttpRequest["method"],
    ...(retry === undefined ? {} : { retry: retry as HttpRequest["retry"] }),
  };
}

function snapshotRetryFailure(failure: unknown): RetryFailureSnapshot {
  if (typeof failure !== "object" || failure === null) {
    throw new TypeError("DefaultRetryPolicy failure must be a non-array object");
  }

  let kind: unknown;
  let isArray: boolean;
  try {
    isArray = Array.isArray(failure);
    kind = Reflect.get(failure, "kind");
  } catch {
    throw new TypeError("DefaultRetryPolicy failure could not be read");
  }

  if (isArray) {
    throw new TypeError("DefaultRetryPolicy failure must be a non-array object");
  }
  if (kind === "network") {
    return { kind: "network" };
  }
  if (kind !== "response") {
    throw new TypeError("DefaultRetryPolicy failure kind must be network or response");
  }

  let status: unknown;
  try {
    status = Reflect.get(failure, "status");
  } catch {
    throw new TypeError("DefaultRetryPolicy failure could not be read");
  }
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("DefaultRetryPolicy response status was invalid");
  }
  return { kind: "response", status, source: failure };
}

function readRetryAfterHeader(failure: object): string | null | undefined {
  let headers: unknown;
  try {
    headers = Reflect.get(failure, "headers");
  } catch {
    throw new TypeError("DefaultRetryPolicy failure could not be read");
  }

  if (headers === undefined) {
    return undefined;
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(headers);
  } catch {
    throw new TypeError("DefaultRetryPolicy response headers were invalid");
  }
  if (typeof headers !== "object" || headers === null || isArray) {
    throw new TypeError("DefaultRetryPolicy response headers were invalid");
  }

  let get: unknown;
  try {
    get = Reflect.get(headers, "get");
  } catch {
    throw new TypeError("DefaultRetryPolicy response headers were invalid");
  }
  if (typeof get !== "function") {
    throw new TypeError("DefaultRetryPolicy response headers were invalid");
  }

  let value: unknown;
  try {
    value = Reflect.apply(get, headers, ["retry-after"]);
  } catch {
    throw new TypeError("DefaultRetryPolicy response headers were invalid");
  }
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError("DefaultRetryPolicy response headers were invalid");
  }
  return value;
}

function requireNumberHook(name: "now" | "random", value: unknown): () => number {
  if (typeof value !== "function") {
    throw new TypeError(`DefaultRetryPolicy ${name} must be callable`);
  }
  return value as () => number;
}

function readFiniteHookResult(name: "now" | "random", hook: () => number): number {
  let value: number;
  try {
    value = hook();
  } catch {
    throw new TypeError(`DefaultRetryPolicy ${name} hook failed`);
  }

  if (!Number.isFinite(value)) {
    throw new RangeError(`DefaultRetryPolicy ${name} hook must return a finite number`);
  }
  return value;
}

export class DefaultRetryPolicy implements RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: DefaultRetryPolicyOptions = {}) {
    const normalizedOptions = snapshotDefaultRetryPolicyOptions(options);
    this.maxRetries = nonNegativeSafeInteger(
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
    positiveSafeInteger("failedAttempt", failedAttempt);
    if (failedAttempt > this.maxRetries) {
      return null;
    }

    const normalizedRequest = snapshotRetryRequest(request);
    if (!this.canRetryMethod(normalizedRequest)) {
      return null;
    }

    const normalizedFailure = snapshotRetryFailure(failure);
    if (normalizedFailure.kind === "response") {
      if (!RETRYABLE_STATUS_CODES.has(normalizedFailure.status)) {
        return null;
      }

      const retryAfterDelay = this.parseRetryAfter(
        readRetryAfterHeader(normalizedFailure.source),
      );
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
    return Number.isFinite(retryAt)
      ? Math.max(0, retryAt - readFiniteHookResult("now", this.now))
      : null;
  }

  private backoffDelay(failedAttempt: number): number {
    const cap = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (failedAttempt - 1));
    const jitter = Math.min(1, Math.max(0, readFiniteHookResult("random", this.random)));
    return Math.floor(cap * jitter);
  }

  private canRetryMethod(request: RetryRequest): boolean {
    if (request.retry === "never") {
      return false;
    }
    return request.retry === "idempotent" || DEFAULT_RETRY_METHODS.has(request.method);
  }
}
