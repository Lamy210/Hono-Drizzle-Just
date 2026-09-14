import type { Meter } from "../../core/observability/meter";
import type { Tracer } from "../../core/observability/tracer";

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

  async operation<TResult>(
    descriptor: DatabaseOperationDescriptor,
    execute: () => Promise<TResult>,
  ): Promise<TResult> {
    const startedAt = this.now();
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
      { kind: "client", attributes },
      async (span) => {
        try {
          const result = await execute();
          span.setStatus("ok");
          return result;
        } catch (error) {
          span.setStatus("error");
          throw error;
        } finally {
          this.options.meter.record(
            "db.client.operation.duration",
            Math.max(0, this.now() - startedAt) / 1_000,
            attributes,
          );
        }
      },
    );
  }

  async transaction<TResult>(execute: () => Promise<TResult>): Promise<TResult> {
    const startedAt = this.now();
    const attributes = { "db.system.name": "postgresql" } as const;

    return this.options.tracer.withSpan(
      "db.transaction",
      { kind: "internal", attributes },
      async (span) => {
        try {
          const result = await execute();
          span.setStatus("ok");
          return result;
        } catch (error) {
          span.setStatus("error");
          throw error;
        } finally {
          this.options.meter.record(
            "db.transaction.duration",
            Math.max(0, this.now() - startedAt) / 1_000,
            attributes,
          );
        }
      },
    );
  }
}
