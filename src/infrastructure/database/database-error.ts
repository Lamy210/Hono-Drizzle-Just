import { AppError } from "../../core/errors/app-error";

const POSTGRES_UNAVAILABLE_CODES = new Set(["53300", "57P01", "57P02", "57P03", "57P04"]);
const RETRYABLE_TRANSACTION_CODES = new Map([
  ["40001", "serialization_failure"],
  ["40P01", "deadlock_detected"],
] as const);
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

interface ErrorMetadata {
  readonly code: unknown;
  readonly message: unknown;
}

function readErrorProperty(
  candidate: object,
  property: "cause" | "code" | "message",
): unknown {
  try {
    return Reflect.get(candidate, property);
  } catch {
    return undefined;
  }
}

function walkErrorChain(error: unknown): readonly ErrorMetadata[] {
  const chain: ErrorMetadata[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    chain.push({
      code: readErrorProperty(current, "code"),
      message: readErrorProperty(current, "message"),
    });
    current = readErrorProperty(current, "cause");
  }

  return chain;
}

function errorCode(candidate: ErrorMetadata): string | undefined {
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

function isAppError(error: unknown): error is AppError {
  try {
    return error instanceof AppError;
  } catch {
    return false;
  }
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

export type RetryableTransactionFailureReason =
  | "serialization_failure"
  | "deadlock_detected";

export function retryableTransactionFailureReason(
  error: unknown,
): RetryableTransactionFailureReason | undefined {
  for (const candidate of walkErrorChain(error)) {
    const code = errorCode(candidate);
    if (code === undefined) {
      continue;
    }
    const reason = RETRYABLE_TRANSACTION_CODES.get(
      code as "40001" | "40P01",
    );
    if (reason !== undefined) {
      return reason;
    }
  }
  return undefined;
}

export function isRetryableTransactionFailure(error: unknown): boolean {
  return retryableTransactionFailureReason(error) !== undefined;
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
  if (isAppError(error)) {
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
