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

class ThrowingMeter implements Meter {
  increment(): void {
    throw new Error("meter increment failed");
  }

  record(): void {
    throw new Error("meter record failed");
  }
}

class ThrowingStatusSpan extends RecordingSpan {
  override setStatus(): void {
    throw new Error("span status failed");
  }
}

class ThrowingStatusTracer implements Tracer {
  async withSpan<T>(
    _name: string,
    _options: SpanOptions,
    operation: (span: Span) => Promise<T>,
  ): Promise<T> {
    return operation(new ThrowingStatusSpan());
  }
}

test("DatabaseObserver keeps successful operations authoritative over observability failures", async () => {
  const observer = new DatabaseObserver({
    tracer: new ThrowingStatusTracer(),
    meter: new ThrowingMeter(),
    now: (() => {
      let reads = 0;
      return () => {
        reads += 1;
        if (reads === 2) {
          throw new Error("duration clock failed");
        }
        return 1_000;
      };
    })(),
  });
  let executions = 0;

  const result = await observer.operation({ operation: "SELECT" }, async () => {
    executions += 1;
    return "ok";
  });

  expect(result).toBe("ok");
  expect(executions).toBe(1);
});

test("DatabaseObserver executes database work when the observability start clock fails", async () => {
  const observer = new DatabaseObserver({
    tracer: new ThrowingStatusTracer(),
    meter: new ThrowingMeter(),
    now: () => {
      throw new Error("clock failed");
    },
  });
  let executions = 0;

  const result = await observer.transaction(async () => {
    executions += 1;
    return "committed";
  });

  expect(result).toBe("committed");
  expect(executions).toBe(1);
});

test("DatabaseObserver preserves transaction errors over observability failures", async () => {
  const raw = Object.assign(new Error("private serialization failure"), { code: "40001" });
  const observer = new DatabaseObserver({
    tracer: new ThrowingStatusTracer(),
    meter: new ThrowingMeter(),
    now: () => 1_000,
  });

  await expect(
    observer.transaction(async () => {
      throw raw;
    }),
  ).rejects.toMatchObject({
    code: "DATABASE_BUSY",
    status: 503,
    cause: raw,
  });
});

test("DatabaseObserver preserves classified database errors over observability failures", async () => {
  const raw = Object.assign(new Error("private statement timeout"), { code: "57014" });
  const observer = new DatabaseObserver({
    tracer: new ThrowingStatusTracer(),
    meter: new ThrowingMeter(),
    now: () => 1_000,
  });

  await expect(
    observer.operation({ operation: "SELECT", collection: "users" }, async () => {
      throw raw;
    }),
  ).rejects.toMatchObject({
    code: "DATABASE_TIMEOUT",
    status: 504,
    cause: raw,
  });
});

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
    recordException: false,
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
    recordException: false,
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
  expect(tracer.spans[0]?.options.recordException).toBe(false);
  expect(tracer.spans[0]?.span.status).toBe("error");
  expect(meter.records).toEqual([
    {
      name: "db.transaction.duration",
      value: 0.35,
      attributes: { "db.system.name": "postgresql" },
    },
  ]);
});
