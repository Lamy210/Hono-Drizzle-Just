import { AppError } from "../../core/errors/app-error";

const POSTGRES_UNAVAILABLE_CODES = new Set(["53300", "57P01", "57P02", "57P03", "57P04"]);
const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);
const NETWORK_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);
const ACQUIRE_TIMEOUT_MESSAGES = new Set([
  "timeout exceeded when trying to connect",
  "connection terminated due to connection timeout",
]);

interface ErrorLike {
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly message?: unknown;
}

function walkErrorChain(error: unknown): readonly ErrorLike[] {
  const chain: ErrorLike[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = current as ErrorLike;
    chain.push(candidate);
    current = candidate.cause;
  }

  return chain;
}

function errorCode(candidate: ErrorLike): string | undefined {
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

function hasCode(error: unknown, predicate: (code: string) => boolean): boolean {
  return walkErrorChain(error).some((candidate) => {
    const code = errorCode(candidate);
    return code !== undefined && predicate(code);
  });
}

export function isDatabaseAcquireTimeout(error: unknown): boolean {
  return walkErrorChain(error).some((candidate) => {
    const code = errorCode(candidate);
    if (code === "ETIMEDOUT") {
      return true;
    }

    return (
      typeof candidate.message === "string" &&
      ACQUIRE_TIMEOUT_MESSAGES.has(candidate.message.toLowerCase())
    );
  });
}

export function isRetryableTransactionFailure(error: unknown): boolean {
  return hasCode(error, (code) => RETRYABLE_TRANSACTION_CODES.has(code));
}

function unavailable(error: unknown): boolean {
  if (
    hasCode(
      error,
      (code) =>
        code.startsWith("08") ||
        POSTGRES_UNAVAILABLE_CODES.has(code) ||
        NETWORK_UNAVAILABLE_CODES.has(code),
    )
  ) {
    return true;
  }

  return isDatabaseAcquireTimeout(error);
}

export function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) {
    return error;
  }

  if (isRetryableTransactionFailure(error) || hasCode(error, (code) => code === "55P03")) {
    return new AppError("DATABASE_BUSY", "Database is temporarily busy", 503, undefined, {
      cause: error,
    });
  }

  if (hasCode(error, (code) => code === "57014" || code === "25P03")) {
    return new AppError("DATABASE_TIMEOUT", "Database operation timed out", 504, undefined, {
      cause: error,
    });
  }

  if (unavailable(error)) {
    return new AppError(
      "DATABASE_UNAVAILABLE",
      "Database is temporarily unavailable",
      503,
      undefined,
      { cause: error },
    );
  }

  return error;
}
