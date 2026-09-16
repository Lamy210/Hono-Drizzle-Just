import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Meter } from "../../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  Tracer,
} from "../../../../src/core/observability/tracer";
import { DatabaseObserver } from "../../../../src/infrastructure/database/database-observer";
import { DrizzleUserRepository } from "../../../../src/modules/users/infrastructure/drizzle-user.repository";
import { createTestDatabase } from "../../../helpers/database";

class RecordingSpan implements Span {
  status: "ok" | "error" | undefined;
  setAttribute(): void {}
  setStatus(status: "ok" | "error"): void {
    this.status = status;
  }
  recordException(): void {}
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
  readonly records: Array<{ name: string; value: number; attributes?: TelemetryAttributes }> = [];
  increment(): void {}
  record(name: string, value: number, attributes?: TelemetryAttributes): void {
    this.records.push({ name, value, ...(attributes ? { attributes } : {}) });
  }
}

const database = createTestDatabase();
const users = new DrizzleUserRepository(database.db);
const repositoryModulePath =
  "../../../../src/modules/users/infrastructure/drizzle-user-creation-idempotency.repository";

beforeAll(async () => {
  await database.pool.query("select 1");
});

afterAll(async () => {
  await database.close();
});

test("ledger operations expose only low-cardinality database metadata", async () => {
  const module = await import(repositoryModulePath).catch(() => undefined);
  expect(module).toBeDefined();
  if (!module) return;

  const tracer = new RecordingTracer();
  const meter = new RecordingMeter();
  const observer = new DatabaseObserver({ tracer, meter });
  const repository = new module.DrizzleUserCreationIdempotencyRepository(database.db, observer);
  const tenantId = `tenant-observed-idempotency-${crypto.randomUUID()}`;
  const rawKey = `secret-idempotency-key-${crypto.randomUUID()}`;
  const keyHash = "8".repeat(64);
  const requestFingerprint = "9".repeat(64);

  await repository.claim({ tenantId, keyHash, requestFingerprint, ttlSeconds: 86_400 });
  const user = await users.create({
    tenantId,
    email: `${crypto.randomUUID()}@example.com`,
    name: "Observed Idempotency",
  });
  await repository.complete({ tenantId, keyHash, requestFingerprint, userId: user.id });

  expect(tracer.spans.length).toBeGreaterThanOrEqual(2);
  for (const { name, options } of tracer.spans) {
    expect(name).toMatch(/^(SELECT|INSERT|UPDATE) user_creation_idempotency$/);
    expect(options.attributes?.["db.system.name"]).toBe("postgresql");
    expect(options.attributes?.["db.collection.name"]).toBe("user_creation_idempotency");
    expect(["SELECT", "INSERT", "UPDATE"]).toContain(options.attributes?.["db.operation.name"]);
    const serialized = JSON.stringify(options.attributes);
    for (const prohibited of [tenantId, rawKey, keyHash, requestFingerprint, user.id]) {
      expect(serialized).not.toContain(prohibited);
    }
  }

  expect(meter.records.length).toBe(tracer.spans.length);
  for (const record of meter.records) {
    expect(record.name).toBe("db.client.operation.duration");
  }
});
