import {
  normalizeDatabaseError,
  type RetryableTransactionFailureReason,
} from "./database-error";
import type { Meter, MetricOptions } from "../../core/observability/meter";
import type {
  Span,
  SpanStatus,
  TelemetryAttributes,
  Tracer,
} from "../../core/observability/tracer";

export type DatabaseNow = () => number;

export interface DatabaseOperationDescriptor {
  readonly operation: string;
  readonly collection?: string;
}

export interface DatabaseObserverOptions {
  readonly tracer: Tracer;
  readonly meter: Meter;
  readonly now?: DatabaseNow;
}

export class DatabaseObserver {
  private readonly now: DatabaseNow;

  constructor(private readonly options: DatabaseObserverOptions) {
    this.now = options.now ?? performance.now.bind(performance);
  }

  private readNowBestEffort(): number | undefined {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private setStatusBestEffort(span: Span, status: SpanStatus): void {
    try {
      span.setStatus(status);
    } catch {
      // Database results and errors are authoritative over observability mutations.
    }
  }

  private incrementBestEffort(
    name: string,
    value: number,
    attributes: TelemetryAttributes,
  ): void {
    try {
      this.options.meter.increment(name, value, attributes);
    } catch {
      // Metrics are observational and must not change database control flow.
    }
  }

  private recordBestEffort(
    name: string,
    value: number,
    attributes: TelemetryAttributes,
    options?: MetricOptions,
  ): void {
    try {
      this.options.meter.record(name, value, attributes, options);
    } catch {
      // Metrics are observational and must not change database control flow.
    }
  }

  private recordDurationBestEffort(
    name: string,
    startedAt: number | undefined,
    attributes: TelemetryAttributes,
  ): void {
    if (startedAt === undefined) {
      return;
    }
    const endedAt = this.readNowBestEffort();
    if (endedAt === undefined) {
      return;
    }
    this.recordBestEffort(name, Math.max(0, endedAt - startedAt) / 1_000, attributes);
  }

  async operation<TResult>(
    descriptor: DatabaseOperationDescriptor,
    execute: () => Promise<TResult>,
  ): Promise<TResult> {
    const startedAt = this.readNowBestEffort();
    const attributes = {
      "db.system.name": "postgresql",
      "db.operation.name": descriptor.operation,
      ...(descriptor.collection === undefined
        ? {}
        : { "db.collection.name": descriptor.collection }),
    } as const;
    const spanName =
      descriptor.collection === undefined
        ? descriptor.operation
        : `${descriptor.operation} ${descriptor.collection}`;

    return this.options.tracer.withSpan(
      spanName,
      { kind: "client", attributes, recordException: false },
      async (span) => {
        try {
          const result = await execute();
          this.setStatusBestEffort(span, "ok");
          return result;
        } catch (error) {
          this.setStatusBestEffort(span, "error");
          throw normalizeDatabaseError(error);
        } finally {
          this.recordDurationBestEffort(
            "db.client.operation.duration",
            startedAt,
            attributes,
          );
        }
      },
    );
  }

  transactionRetryScheduled(
    reason: RetryableTransactionFailureReason,
    delayMs: number,
  ): void {
    const attributes = {
      "db.system.name": "postgresql",
      "db.transaction.retry.reason": reason,
    } as const;
    this.incrementBestEffort("db.transaction.retries", 1, attributes);
    this.recordBestEffort(
      "db.transaction.retry.delay",
      Math.max(0, delayMs) / 1_000,
      attributes,
      { unit: "s" },
    );
  }

  transactionRetryExhausted(reason: RetryableTransactionFailureReason): void {
    this.incrementBestEffort(
      "db.transaction.retry.exhausted",
      1,
      {
        "db.system.name": "postgresql",
        "db.transaction.retry.reason": reason,
      },
    );
  }

  async transaction<TResult>(execute: () => Promise<TResult>): Promise<TResult> {
    const startedAt = this.readNowBestEffort();
    const attributes = { "db.system.name": "postgresql" } as const;

    return this.options.tracer.withSpan(
      "db.transaction",
      { kind: "internal", attributes, recordException: false },
      async (span) => {
        try {
          const result = await execute();
          this.setStatusBestEffort(span, "ok");
          return result;
        } catch (error) {
          this.setStatusBestEffort(span, "error");
          throw normalizeDatabaseError(error);
        } finally {
          this.recordDurationBestEffort("db.transaction.duration", startedAt, attributes);
        }
      },
    );
  }
}
