import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { users } from "../../../src/db/schema";
import type { Meter } from "../../../src/core/observability/meter";
import type {
  Span,
  SpanOptions,
  TelemetryAttributes,
  Tracer,
} from "../../../src/core/observability/tracer";
import { DatabaseObserver } from "../../../src/infrastructure/database/database-observer";
import { DrizzleTransactionManager } from "../../../src/infrastructure/database/drizzle-transaction-manager";
import type { UserUnitOfWork } from "../../../src/modules/users/application/user-unit-of-work";
import { DrizzleUserRepository } from "../../../src/modules/users/infrastructure/drizzle-user.repository";
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
const transactions = new DrizzleTransactionManager<UserUnitOfWork>(
  database.db,
  (session) => ({ users: new DrizzleUserRepository(session, observer) }),
  observer,
);

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

test("transaction manager wraps the unit of work in one transaction span with child query measurements", async () => {
  const email = `transaction-observed-${crypto.randomUUID()}@example.com`;

  const created = await transactions.run((unitOfWork) =>
    unitOfWork.users.create({ email, name: "Observed transaction" }),
  );

  expect(created.email).toBe(email);
  expect(tracer.spans.map((entry) => entry.name)).toEqual(["db.transaction", "INSERT users"]);
  expect(tracer.spans[0]?.span.status).toBe("ok");
  expect(tracer.spans[1]?.span.status).toBe("ok");
  expect(meter.records.map((entry) => entry.name)).toContain("db.transaction.duration");
  expect(meter.records.map((entry) => entry.name)).toContain("db.client.operation.duration");
});
