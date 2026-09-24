import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { users } from "../../../src/db/schema";
import { createDatabaseAccess } from "../../../src/app/composition/database-access";
import type { Meter } from "../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  Tracer,
} from "../../../src/core/observability/tracer";
import { DatabaseObserver } from "../../../src/infrastructure/database/database-observer";
import { createTestDatabase } from "../../helpers/database";

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
const access = createDatabaseAccess(database.db, observer);

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

test("idempotency maintenance is observed outside the business transaction", async () => {
  const localTracer = new RecordingTracer();
  const localMeter = new RecordingMeter();
  const localObserver = new DatabaseObserver({ tracer: localTracer, meter: localMeter });
  const localAccess = createDatabaseAccess(database.db, localObserver);
  const tenantId = `tenant-maintenance-composition-${crypto.randomUUID()}`;

  await localAccess.userCreationIdempotencyMaintenance.cleanupIfDue();
  await localAccess.userTransactions.run((unitOfWork) =>
    unitOfWork.users.create({
      tenantId,
      email: `${crypto.randomUUID()}@example.com`,
      name: "Maintenance Isolation",
    }),
  );

  expect(localTracer.spans.map((entry) => entry.name)).toEqual([
    "DELETE user_creation_idempotency",
    "db.transaction",
    "INSERT users",
  ]);
});

test("database access composition shares one observer across tenant-scoped transactions and repositories", async () => {
  const email = `composition-observed-${crypto.randomUUID()}@example.com`;
  const tenantId = "tenant-composition";

  const created = await access.userTransactions.run((unitOfWork) =>
    unitOfWork.users.create({ tenantId, email, name: "Composition" }),
  );
  const found = await access.userRepository.findById(tenantId, created.id);

  expect(found?.email).toBe(email);
  expect(tracer.spans.map((entry) => entry.name)).toEqual([
    "db.transaction",
    "INSERT users",
    "SELECT users",
  ]);
  expect(meter.records.map((entry) => entry.name)).toEqual([
    "db.client.operation.duration",
    "db.transaction.duration",
    "db.client.operation.duration",
  ]);
});
