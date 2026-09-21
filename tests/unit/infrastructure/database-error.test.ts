import { expect, test } from "bun:test";
import { AppError } from "../../../src/core/errors/app-error";
import {
  isDatabaseAcquireTimeout,
  isRetryableTransactionFailure,
  normalizeDatabaseError,
  retryableTransactionFailureReason,
} from "../../../src/infrastructure/database/database-error";

function codedError(code: string, message = "database failed", cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

test("classifies PostgreSQL serialization and deadlock failures as retryable database busy", () => {
  for (const code of ["40001", "40P01"]) {
    const raw = codedError(code, "sensitive concurrency diagnostic");

    expect(isRetryableTransactionFailure(raw)).toBe(true);
    expect(retryableTransactionFailureReason(raw)).toBe(
      code === "40001" ? "serialization_failure" : "deadlock_detected",
    );
    expect(normalizeDatabaseError(raw)).toMatchObject({
      code: "DATABASE_BUSY",
      message: "Database is temporarily busy",
      status: 503,
      cause: raw,
    });
  }

  expect(isRetryableTransactionFailure(codedError("23505"))).toBe(false);
  expect(retryableTransactionFailureReason(codedError("23505"))).toBeUndefined();
});

test("classifies PostgreSQL lock waits as retryable database busy failures", () => {
  const raw = codedError("55P03", "canceling statement due to lock timeout");
  const normalized = normalizeDatabaseError(raw);

  expect(normalized).toBeInstanceOf(AppError);
  expect(normalized).toMatchObject({
    code: "DATABASE_BUSY",
    message: "Database is temporarily busy",
    status: 503,
    cause: raw,
  });
});

test("classifies PostgreSQL query/session cancellation as database timeout", () => {
  for (const code of ["57014", "25P03"]) {
    const raw = codedError(code, "sensitive postgres diagnostic");
    const normalized = normalizeDatabaseError(raw);

    expect(normalized).toBeInstanceOf(AppError);
    expect(normalized).toMatchObject({
      code: "DATABASE_TIMEOUT",
      message: "Database operation timed out",
      status: 504,
      cause: raw,
    });
  }
});

test("classifies PostgreSQL and network connection failures as unavailable", () => {
  for (const code of ["08006", "57P03", "53300", "ECONNREFUSED"]) {
    const raw = codedError(code);
    const normalized = normalizeDatabaseError(raw);

    expect(normalized).toBeInstanceOf(AppError);
    expect(normalized).toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      message: "Database is temporarily unavailable",
      status: 503,
      cause: raw,
    });
  }
});

test("classifies node-postgres acquisition timeout messages without broad timeout matching", () => {
  for (const message of [
    "timeout exceeded when trying to connect",
    "Connection terminated due to connection timeout",
  ]) {
    expect(isDatabaseAcquireTimeout(new Error(message))).toBe(true);
    expect(normalizeDatabaseError(new Error(message))).toMatchObject({
      code: "DATABASE_UNAVAILABLE",
      status: 503,
    });
  }

  expect(isDatabaseAcquireTimeout(new Error("statement timeout from unrelated layer"))).toBe(false);
});

test("preserves AppError, domain-significant SQLSTATEs, unknown errors, and cyclic causes", () => {
  const appError = new AppError("CONFLICT", "Already exists", 409);
  expect(normalizeDatabaseError(appError)).toBe(appError);

  const unique = codedError("23505", "duplicate key value violates unique constraint secret_name");
  expect(normalizeDatabaseError(unique)).toBe(unique);

  const unknown = new Error("unknown database adapter failure");
  expect(normalizeDatabaseError(unknown)).toBe(unknown);

  const cyclic = Object.assign(new Error("cycle"), { code: "UNKNOWN", cause: undefined as unknown });
  cyclic.cause = cyclic;
  expect(normalizeDatabaseError(cyclic)).toBe(cyclic);
});
