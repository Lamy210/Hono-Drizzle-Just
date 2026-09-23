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

test("findById records SELECT users without tenant or identifier cardinality", async () => {
  const seeded = await userFactory.create({
    tenantId: "tenant-observed-id",
    email: `observed-${crypto.randomUUID()}@example.com`,
  });

  const found = await repository.findById(seeded.tenantId, seeded.id);

  expect(found?.id).toBe(seeded.id);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("SELECT users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.collection.name": "users",
  });
  const attributes = JSON.stringify(tracer.spans[0]?.options.attributes);
  expect(attributes).not.toContain(seeded.id);
  expect(attributes).not.toContain(seeded.tenantId);
  expect(meter.records[0]?.name).toBe("db.client.operation.duration");
});

test("findByEmail records SELECT users without tenant or email cardinality", async () => {
  const email = `email-observed-${crypto.randomUUID()}@example.com`;
  const tenantId = "tenant-observed-email";
  await userFactory.create({ tenantId, email });

  const found = await repository.findByEmail(tenantId, email);

  expect(found?.email).toBe(email);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("SELECT users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "SELECT",
    "db.collection.name": "users",
  });
  const attributes = JSON.stringify(tracer.spans[0]?.options.attributes);
  expect(attributes).not.toContain(email);
  expect(attributes).not.toContain(tenantId);
});

test("listPage records bounded SELECT telemetry without tenant or pagination cardinality", async () => {
  const email = `list-observed-${crypto.randomUUID()}@example.com`;
  const tenantId = "tenant-observed-list";
  await userFactory.create({ tenantId, email });

  const result = await repository.listPage(tenantId, { offset: 0, limit: 20 });

  expect(result.total).toBe(1);
  expect(result.users[0]?.email).toBe(email);
  expect(tracer.spans.map((entry) => entry.name)).toEqual(["SELECT users", "SELECT users"]);
  expect(meter.records).toHaveLength(2);
  const telemetry = JSON.stringify({
    spans: tracer.spans.map((entry) => entry.options.attributes),
    records: meter.records,
  });
  expect(telemetry).not.toContain(tenantId);
  expect(telemetry).not.toContain(email);
  expect(telemetry).not.toContain('"offset"');
  expect(telemetry).not.toContain('"limit"');
});

test("delete records DELETE users without tenant or id cardinality", async () => {
  const tenantId = "tenant-observed-delete";
  const seeded = await userFactory.create({
    tenantId,
    email: `delete-observed-${crypto.randomUUID()}@example.com`,
  });
  tracer.spans.length = 0;
  meter.records.length = 0;

  expect(await repository.deleteById(tenantId, seeded.id)).toBe(true);

  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("DELETE users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "DELETE",
    "db.collection.name": "users",
  });
  const telemetry = JSON.stringify({
    attributes: tracer.spans[0]?.options.attributes,
    records: meter.records,
  });
  expect(telemetry).not.toContain(tenantId);
  expect(telemetry).not.toContain(seeded.id);
});

test("successful conditional update records one UPDATE span without tenant, id, or version cardinality", async () => {
  const tenantId = "tenant-observed-update";
  const seeded = await userFactory.create({
    tenantId,
    email: `update-observed-${crypto.randomUUID()}@example.com`,
  });
  tracer.spans.length = 0;
  meter.records.length = 0;

  const updated = await repository.update(
    tenantId,
    seeded.id,
    { name: "Updated" },
    { kind: "versions", versions: [seeded.version] },
  );

  expect(updated).toMatchObject({
    state: "updated",
    user: { name: "Updated", version: seeded.version + 1 },
  });
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("UPDATE users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "UPDATE",
    "db.collection.name": "users",
  });
  const telemetry = JSON.stringify({
    attributes: tracer.spans[0]?.options.attributes,
    records: meter.records,
  });
  expect(telemetry).not.toContain(tenantId);
  expect(telemetry).not.toContain(seeded.id);
  expect(telemetry).not.toContain("Updated");
  expect(telemetry).not.toContain(String(seeded.version));
});

test("stale conditional update records bounded UPDATE then existence SELECT telemetry", async () => {
  const tenantId = "tenant-observed-stale-update";
  const seeded = await userFactory.create({
    tenantId,
    email: `stale-update-observed-${crypto.randomUUID()}@example.com`,
  });
  tracer.spans.length = 0;
  meter.records.length = 0;

  const result = await repository.update(
    tenantId,
    seeded.id,
    { name: "Stale" },
    { kind: "versions", versions: [seeded.version + 10] },
  );

  expect(result).toEqual({ state: "precondition_failed" });
  expect(tracer.spans.map((entry) => entry.name)).toEqual([
    "UPDATE users",
    "SELECT users",
  ]);
  const telemetry = JSON.stringify({
    spans: tracer.spans.map((entry) => entry.options.attributes),
    records: meter.records,
  });
  expect(telemetry).not.toContain(tenantId);
  expect(telemetry).not.toContain(seeded.id);
  expect(telemetry).not.toContain("Stale");
});

test("create records INSERT users without tenant or input cardinality", async () => {
  const email = `insert-observed-${crypto.randomUUID()}@example.com`;
  const tenantId = "tenant-observed-create";

  const created = await repository.create({ tenantId, email, name: "Observed" });

  expect(created.email).toBe(email);
  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("INSERT users");
  expect(tracer.spans[0]?.options.attributes).toEqual({
    "db.system.name": "postgresql",
    "db.operation.name": "INSERT",
    "db.collection.name": "users",
  });
  const attributes = JSON.stringify(tracer.spans[0]?.options.attributes);
  expect(attributes).not.toContain(email);
  expect(attributes).not.toContain("Observed");
  expect(attributes).not.toContain(tenantId);
});

test("duplicate tenant-local create keeps conflict mapping and marks the database span as an error", async () => {
  const email = `duplicate-observed-${crypto.randomUUID()}@example.com`;
  const tenantId = "tenant-observed-duplicate";
  await repository.create({ tenantId, email, name: "First" });
  tracer.spans.length = 0;
  meter.records.length = 0;

  await expect(repository.create({ tenantId, email, name: "Duplicate" })).rejects.toMatchObject({
    code: "CONFLICT",
    status: 409,
  });

  expect(tracer.spans).toHaveLength(1);
  expect(tracer.spans[0]?.name).toBe("INSERT users");
  expect(tracer.spans[0]?.span.status).toBe("error");
  expect(meter.records).toHaveLength(1);
  const attributes = JSON.stringify(tracer.spans[0]?.options.attributes);
  expect(attributes).not.toContain(email);
  expect(attributes).not.toContain(tenantId);
});
