import type {
  TransactionManager,
  TransactionRunOptions,
} from "../../core/transaction/transaction-manager";
import type { Database, DatabaseSession } from "./database";
import {
  retryableTransactionFailureReason,
  type RetryableTransactionFailureReason,
} from "./database-error";
import type { DatabaseObserver } from "./database-observer";

export type UnitOfWorkFactory<TUnitOfWork> = (session: DatabaseSession) => TUnitOfWork;
export type TransactionRetrySleep = (delayMs: number) => Promise<void>;

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
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: TransactionRetrySleep;

  constructor(
    private readonly database: Database,
    private readonly createUnitOfWork: UnitOfWorkFactory<TUnitOfWork>,
    private readonly observer?: DatabaseObserver,
    options: DrizzleTransactionManagerOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;

    requireInteger("maxAttempts", this.maxAttempts, 1, 10);
    requireInteger("baseDelayMs", this.baseDelayMs, 0, 10_000);
    requireInteger("maxDelayMs", this.maxDelayMs, 0, 60_000);
    if (this.maxDelayMs < this.baseDelayMs) {
      throw new RangeError("maxDelayMs must be greater than or equal to baseDelayMs");
    }
  }

  async run<TResult>(
    operation: (unitOfWork: TUnitOfWork) => Promise<TResult>,
    options: TransactionRunOptions = {},
  ): Promise<TResult> {
    const execute = () =>
      this.database.transaction(async (transaction) =>
        operation(this.createUnitOfWork(transaction)),
      );
    const executeAttempt = () =>
      this.observer ? this.observer.transaction(execute) : execute();

    if (options.retry !== "safe") {
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
        await this.sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private retryDelayMs(failedAttempt: number): number {
    const cap = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
    );
    const sample = this.random();
    const ratio = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
    return Math.floor(cap * ratio);
  }
}

export type { RetryableTransactionFailureReason };
