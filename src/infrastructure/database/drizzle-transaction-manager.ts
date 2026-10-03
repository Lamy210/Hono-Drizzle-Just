import { AppError } from "../../core/errors/app-error";
import type {
  TransactionManager,
  TransactionRunOptions,
} from "../../core/transaction/transaction-manager";
import type { Database, DatabaseSession } from "./database";
import { retryableTransactionFailureReason } from "./database-error";
import type { DatabaseObserver } from "./database-observer";

export type UnitOfWorkFactory<TUnitOfWork> = (session: DatabaseSession) => TUnitOfWork;
export type TransactionRetrySleep = (delayMs: number) => Promise<void>;

type DatabaseTransactionRunner = <TResult>(
  operation: (transaction: DatabaseSession) => Promise<TResult>,
) => Promise<TResult>;

type TransactionObserver = Pick<
  DatabaseObserver,
  "transaction" | "transactionRetryScheduled" | "transactionRetryExhausted"
>;

export interface DrizzleTransactionManagerOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly random?: () => number;
  readonly sleep?: TransactionRetrySleep;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 10;
const DEFAULT_MAX_DELAY_MS = 100;

function snapshotTransactionManagerOptions(
  options: unknown,
): DrizzleTransactionManagerOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("DrizzleTransactionManager options must be a non-array object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(options);
  } catch {
    throw new TypeError("DrizzleTransactionManager options could not be read");
  }
  if (isArray) {
    throw new TypeError("DrizzleTransactionManager options must be a non-array object");
  }

  try {
    const maxAttempts = Reflect.get(
      options,
      "maxAttempts",
    ) as DrizzleTransactionManagerOptions["maxAttempts"];
    const baseDelayMs = Reflect.get(
      options,
      "baseDelayMs",
    ) as DrizzleTransactionManagerOptions["baseDelayMs"];
    const maxDelayMs = Reflect.get(
      options,
      "maxDelayMs",
    ) as DrizzleTransactionManagerOptions["maxDelayMs"];
    const random = Reflect.get(
      options,
      "random",
    ) as DrizzleTransactionManagerOptions["random"];
    const sleep = Reflect.get(
      options,
      "sleep",
    ) as DrizzleTransactionManagerOptions["sleep"];

    return {
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
      ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
      ...(random === undefined ? {} : { random }),
      ...(sleep === undefined ? {} : { sleep }),
    };
  } catch {
    throw new TypeError("DrizzleTransactionManager options could not be read");
  }
}

function snapshotTransactionRunOptions(options: unknown): TransactionRunOptions {
  if (typeof options !== "object" || options === null) {
    throw new TypeError(
      "DrizzleTransactionManager run options must be a non-array object",
    );
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(options);
  } catch {
    throw new TypeError("DrizzleTransactionManager run options could not be read");
  }
  if (isArray) {
    throw new TypeError(
      "DrizzleTransactionManager run options must be a non-array object",
    );
  }

  let retry: unknown;
  try {
    retry = Reflect.get(options, "retry");
  } catch {
    throw new TypeError("DrizzleTransactionManager run options could not be read");
  }

  if (retry === undefined) {
    return {};
  }
  if (retry !== "never" && retry !== "safe") {
    throw new TypeError('DrizzleTransactionManager retry must be "never" or "safe"');
  }
  return { retry };
}

function normalizeDatabaseTransaction(database: unknown): DatabaseTransactionRunner {
  if (
    database === null ||
    (typeof database !== "object" && typeof database !== "function")
  ) {
    throw new TypeError("DrizzleTransactionManager database transaction could not be read");
  }

  let transaction: unknown;
  try {
    transaction = Reflect.get(database, "transaction");
  } catch {
    throw new TypeError("DrizzleTransactionManager database transaction could not be read");
  }
  if (typeof transaction !== "function") {
    throw new TypeError("DrizzleTransactionManager database transaction must be callable");
  }

  return ((operation: (transaction: DatabaseSession) => Promise<unknown>) =>
    Reflect.apply(transaction, database, [operation])) as DatabaseTransactionRunner;
}

function requireUnitOfWorkFactory<TUnitOfWork>(
  value: unknown,
): UnitOfWorkFactory<TUnitOfWork> {
  if (typeof value !== "function") {
    throw new TypeError("DrizzleTransactionManager unit-of-work factory must be callable");
  }
  return value as UnitOfWorkFactory<TUnitOfWork>;
}

function normalizeTransactionObserver(observer: unknown): TransactionObserver | undefined {
  if (observer === undefined) {
    return undefined;
  }
  if (
    observer === null ||
    (typeof observer !== "object" && typeof observer !== "function")
  ) {
    throw new TypeError("DrizzleTransactionManager observer must be a non-null object");
  }

  let transaction: unknown;
  let transactionRetryScheduled: unknown;
  let transactionRetryExhausted: unknown;
  try {
    transaction = Reflect.get(observer, "transaction");
    transactionRetryScheduled = Reflect.get(observer, "transactionRetryScheduled");
    transactionRetryExhausted = Reflect.get(observer, "transactionRetryExhausted");
  } catch {
    throw new TypeError("DrizzleTransactionManager observer wiring could not be read");
  }

  if (typeof transaction !== "function") {
    throw new TypeError("DrizzleTransactionManager observer transaction must be callable");
  }
  if (typeof transactionRetryScheduled !== "function") {
    throw new TypeError(
      "DrizzleTransactionManager observer transactionRetryScheduled must be callable",
    );
  }
  if (typeof transactionRetryExhausted !== "function") {
    throw new TypeError(
      "DrizzleTransactionManager observer transactionRetryExhausted must be callable",
    );
  }

  const normalizedTransaction = ((execute: () => Promise<unknown>) =>
    Reflect.apply(transaction, observer, [execute])) as TransactionObserver["transaction"];
  const normalizedRetryScheduled = ((
    reason: Parameters<TransactionObserver["transactionRetryScheduled"]>[0],
    delayMs: number,
  ) =>
    Reflect.apply(transactionRetryScheduled, observer, [
      reason,
      delayMs,
    ])) as TransactionObserver["transactionRetryScheduled"];
  const normalizedRetryExhausted = ((
    reason: Parameters<TransactionObserver["transactionRetryExhausted"]>[0],
  ) =>
    Reflect.apply(transactionRetryExhausted, observer, [
      reason,
    ])) as TransactionObserver["transactionRetryExhausted"];

  return {
    transaction: normalizedTransaction,
    transactionRetryScheduled: normalizedRetryScheduled,
    transactionRetryExhausted: normalizedRetryExhausted,
  };
}

function requireRandomHook(value: unknown): () => number {
  if (typeof value !== "function") {
    throw new TypeError("DrizzleTransactionManager random must be callable");
  }
  return value as () => number;
}

function requireSleepHook(value: unknown): TransactionRetrySleep {
  if (typeof value !== "function") {
    throw new TypeError("DrizzleTransactionManager sleep must be callable");
  }
  return value as TransactionRetrySleep;
}

function defaultSleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function requireInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

export class DrizzleTransactionManager<TUnitOfWork>
  implements TransactionManager<TUnitOfWork>
{
  private readonly runDatabaseTransaction: DatabaseTransactionRunner;
  private readonly createUnitOfWork: UnitOfWorkFactory<TUnitOfWork>;
  private readonly observer?: TransactionObserver;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: TransactionRetrySleep;

  constructor(
    database: Database,
    createUnitOfWork: UnitOfWorkFactory<TUnitOfWork>,
    observer?: DatabaseObserver,
    options: DrizzleTransactionManagerOptions = {},
  ) {
    const normalizedOptions = snapshotTransactionManagerOptions(options);
    this.maxAttempts =
      normalizedOptions.maxAttempts === undefined
        ? DEFAULT_MAX_ATTEMPTS
        : normalizedOptions.maxAttempts;
    this.baseDelayMs =
      normalizedOptions.baseDelayMs === undefined
        ? DEFAULT_BASE_DELAY_MS
        : normalizedOptions.baseDelayMs;
    this.maxDelayMs =
      normalizedOptions.maxDelayMs === undefined
        ? DEFAULT_MAX_DELAY_MS
        : normalizedOptions.maxDelayMs;
    this.random =
      normalizedOptions.random === undefined
        ? Math.random
        : requireRandomHook(normalizedOptions.random);
    this.sleep =
      normalizedOptions.sleep === undefined
        ? defaultSleep
        : requireSleepHook(normalizedOptions.sleep);

    requireInteger("maxAttempts", this.maxAttempts, 1, 10);
    requireInteger("baseDelayMs", this.baseDelayMs, 0, 10_000);
    requireInteger("maxDelayMs", this.maxDelayMs, 0, 60_000);
    if (this.maxDelayMs < this.baseDelayMs) {
      throw new RangeError("maxDelayMs must be greater than or equal to baseDelayMs");
    }

    this.runDatabaseTransaction = normalizeDatabaseTransaction(database);
    this.createUnitOfWork = requireUnitOfWorkFactory(createUnitOfWork);
    this.observer = normalizeTransactionObserver(observer);
  }

  async run<TResult>(
    operation: (unitOfWork: TUnitOfWork) => Promise<TResult>,
    options: TransactionRunOptions = {},
  ): Promise<TResult> {
    if (typeof operation !== "function") {
      throw new TypeError("DrizzleTransactionManager operation must be callable");
    }
    const normalizedOptions = snapshotTransactionRunOptions(options);

    const execute = () =>
      this.runDatabaseTransaction(async (transaction) =>
        operation(this.createUnitOfWork(transaction)),
      );
    const executeAttempt = () =>
      this.observer ? this.observer.transaction(execute) : execute();

    if (normalizedOptions.retry !== "safe") {
      return executeAttempt();
    }

    let attempt = 1;
    while (true) {
      try {
        return await executeAttempt();
      } catch (error) {
        const reason = retryableTransactionFailureReason(error);
        if (reason === undefined) {
          throw error;
        }
        if (attempt >= this.maxAttempts) {
          this.observer?.transactionRetryExhausted(reason);
          throw error;
        }

        const delayMs = this.retryDelayMs(attempt);
        this.observer?.transactionRetryScheduled(reason, delayMs);
        await this.waitBeforeRetry(delayMs);
        attempt += 1;
      }
    }
  }

  private async waitBeforeRetry(delayMs: number): Promise<void> {
    try {
      await this.sleep(delayMs);
    } catch {
      throw new AppError(
        "INTERNAL_ERROR",
        "Database transaction retry delay failed",
        500,
      );
    }
  }

  private retryDelayMs(failedAttempt: number): number {
    const cap = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
    );
    let sample: number;
    try {
      sample = this.random();
    } catch {
      throw new AppError(
        "INTERNAL_ERROR",
        "Database transaction retry random hook failed",
        500,
      );
    }
    const ratio = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
    return Math.floor(cap * ratio);
  }
}
