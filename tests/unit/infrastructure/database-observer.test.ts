import { expect, test } from "bun:test";
import type { Meter } from "../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  SpanStatus,
  TelemetryAttributes,
  TelemetryAttributeValue,
  Tracer,
} from "../../../src/core/observability/tracer";
import { DatabaseObserver } from "../../../src/infrastructure/database/database-observer";

class RecordingSpan implements Span {
  readonly attributes = new Map<string, TelemetryAttributeValue>();
  status: SpanStatus | undefined;
  exceptions: unknown[] = [];

  setAttribute(name: string, value: TelemetryAttributeValue): void {
    this.attributes.set(name, value);
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }

  recordException(error: unknown): void {
    this.exceptions.push(error);
  }

  traceContext() {
    return undefined;
  }
}

class RecordingTracer implements Tracer {
  readonly spans: Array<{ name: string; options: SpanOptions; span: RecordingSpan }> = [];

  async withSpan<T>(
    name: string,
    options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = new RecordingSpan();
    this.spans.push({ name, options, span });
    return operation(span);
  }
}

class RecordingMeter implements Meter {
  readonly increments: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];
  readonly records: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];

  increment(name: string, value = 1, attributes?: TelemetryAttributes): void {
    this.increments.push({ name, value, ...(attributes ? { attributes } : {}) });
  }

  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.records.push({ name, value, ...(attributes ? { attributes } : {}) });
  }
}

test("DatabaseObserver records a low-cardinality successful database operation", async () => {
  const tracer = new RecordingTracer();
  const meter = new RecordingMeter();
  let now = 1_000;
  const observer = new DatabaseObserver({ tracer, meter, now: () => now });

  const result = await observer.operation(
    { operation: "SELECT", collection: "users" },
    async () => {
      now = 1_250;
      return "ok";
    },
  );

  expect(result).toBe("ok");
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("SELECT users");
  expect(tracer.spans[0]?.options).toMatchObject({
    kind: "client",
    attributes: {
      "db.system.name": "postgresql",
      "db.operation.name": "SELECT",
      "db.collection.name": "users",
    },
  });
  expect(tracer.spans[0]?.span.status).toBe("ok");
  expect(meter.records).toEqual([
    {
      name: "db.client.operation.duration",
      value: 0.25,
      attributes: {
        "db.system.name": "postgresql",
        "db.operation.name": "SELECT",
        "db.collection.name": "users",
      },
    },
  ]);
});

test("DatabaseObserver records successful transaction duration separately from query metrics", async () => {
  const tracer = new RecordingTracer();
  const meter = new RecordingMeter();
  let now = 2_000;
  const observer = new DatabaseObserver({ tracer, meter, now: () => now });

  const result = await observer.transaction(async () => {
    now = 2_400;
    return "committed";
  });

  expect(result).toBe("committed");
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("db.transaction");
  expect(tracer.spans[0]?.options).toEqual({
    kind: "internal",
    attributes: { "db.system.name": "postgresql" },
  });
  expect(tracer.spans[0]?.span.status).toBe("ok");
  expect(meter.records).toEqual([
    {
      name: "db.transaction.duration",
      value: 0.4,
      attributes: { "db.system.name": "postgresql" },
    },
  ]);
});

test("DatabaseObserver records failed transaction duration and preserves the original error", async () => {
  const tracer = new RecordingTracer();
  const meter = new RecordingMeter();
  let now = 3_000;
  const observer = new DatabaseObserver({ tracer, meter, now: () => now });
  const failure = new Error("rollback");

  await expect(
    observer.transaction(async () => {
      now = 3_350;
      throw failure;
    }),
  ).rejects.toBe(failure);

  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.span.status).toBe("error");
  expect(meter.records).toEqual([
    {
      name: "db.transaction.duration",
      value: 0.35,
      attributes: { "db.system.name": "postgresql" },
    },
  ]);
});
