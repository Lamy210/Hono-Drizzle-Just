import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { users } from "../../../../src/db/schema";
import type { Meter } from "../../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  Tracer,
} from "../../../../src/core/observability/tracer";
import { DatabaseObserver } from "../../../../src/infrastructure/database/database-observer";
import { DrizzleUserRepository } from "../../../../src/modules/users/infrastructure/drizzle-user.repository";
import { makeUserFactory } from "../../../factories/user.factory";
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
const tracer = new RecordingTracer();
const meter = new RecordingMeter();
const observer = new DatabaseObserver({ tracer, meter });
const repository = new DrizzleUserRepository(database.db, observer);
const userFactory = makeUserFactory(database.db);

beforeAll(async () => {
  await database.pool.query("select 1");
});

beforeEach(async () => {
  await database.db.delete(users);
  tracer.spans.length = 0;
  meter.records.length = 0;
});

afterAll(async () => {
  await database.close();
});

test("findById records SELECT users without identifier cardinality", async () => {
  const seeded = await userFactory.create({ email: `observed-${crypto.randomUUID()}@example.com` });

  const found = await repository.findById(seeded.id);

  expect(found?.id).toBe(seeded.id);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("SELECT users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.collection.name": "users",
  });
  expect(JSON.stringify(tracer.spans[0]?.options.attributes)).not.toContain(seeded.id);
  expect(meter.records[0]?.name).toBe("db.client.operation.duration");
});

test("findByEmail records SELECT users without email cardinality", async () => {
  const email = `email-observed-${crypto.randomUUID()}@example.com`;
  await userFactory.create({ email });

  const found = await repository.findByEmail(email);

  expect(found?.email).toBe(email);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("SELECT users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.collection.name": "users",
  });
  expect(JSON.stringify(tracer.spans[0]?.options.attributes)).not.toContain(email);
});

test("create records INSERT users without input cardinality", async () => {
  const email = `insert-observed-${crypto.randomUUID()}@example.com`;

  const created = await repository.create({ email, name: "Observed" });

  expect(created.email).toBe(email);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("INSERT users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "INSERT",
    "db.collection.name": "users",
  });
  expect(JSON.stringify(tracer.spans[0]?.options.attributes)).not.toContain(email);
  expect(JSON.stringify(tracer.spans[0]?.options.attributes)).not.toContain("Observed");
});

test("duplicate create keeps conflict mapping and marks the database span as an error", async () => {
  const email = `duplicate-observed-${crypto.randomUUID()}@example.com`;
  await repository.create({ email, name: "First" });
  tracer.spans.length = 0;
  meter.records.length = 0;

  await expect(repository.create({ email, name: "Duplicate" })).rejects.toMatchObject({
    code: "CONFLICT",
    status: 409,
  });

  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("INSERT users");
  expect(tracer.spans[0]?.span.status).toBe("error");
  expect(meter.records).toHaveLength(1);
  expect(JSON.stringify(tracer.spans[0]?.options.attributes)).not.toContain(email);
});
