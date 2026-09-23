import { expect, mock, spyOn, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";
import { UpdateUserService } from "../../../../src/modules/users/application/update-user.service";

const context: RequestContext = {
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  },
  startedAt: 0,
  principal: {
    subject: "user-123",
    tenantId: "tenant-a",
    scopes: ["users:write"],
  },
};

const versionPrecondition = { kind: "versions" as const, versions: [1] };

function loggingHarness() {
  const logger = new JsonConsoleLogger({}, () => undefined);
  return { logger, info: spyOn(logger, "info") };
}

test("normalizes partial updates, scopes them to the tenant, and logs only stable identifiers", async () => {
  const updated = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-a",
    email: "updated@example.com",
    name: "Updated",
    version: 2,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
  };
  const update = mock(async () => ({ state: "updated" as const, user: updated }));
  const { logger, info } = loggingHarness();
  const service = new UpdateUserService({ update }, logger);

  const result = await service.execute(
    "550E8400-E29B-41D4-A716-446655440000",
    { email: " UPDATED@Example.com ", name: " Updated " },
    versionPrecondition,
    context,
  );

  expect(update).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
    { email: "updated@example.com", name: "Updated" },
    versionPrecondition,
  );
  expect(result).toEqual(updated);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("user.updated", {
    userId: updated.id,
    requestId: context.requestId,
    traceId: context.trace.traceId,
  });
  const serialized = JSON.stringify(info.mock.calls);
  expect(serialized).not.toContain(updated.email);
  expect(serialized).not.toContain(updated.name);
  expect(serialized).not.toContain(updated.tenantId);
});

test("requires a precondition only after authorization and input validation", async () => {
  const update = mock(async () => ({ state: "not_found" as const }));
  const { logger, info } = loggingHarness();
  const service = new UpdateUserService({ update }, logger);

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      { name: "Updated" },
      undefined,
      context,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_REQUIRED", status: 428 });

  expect(update).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();

  const readOnly: RequestContext = {
    ...context,
    principal: {
      subject: "user-123",
      tenantId: "tenant-a",
      scopes: ["users:read"],
    },
  };
  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      { name: "Updated" },
      undefined,
      readOnly,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
});

test("maps a stale version to precondition failed without a business log", async () => {
  const update = mock(async () => ({ state: "precondition_failed" as const }));
  const { logger, info } = loggingHarness();
  const service = new UpdateUserService({ update }, logger);

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      { name: "Updated" },
      versionPrecondition,
      context,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", status: 412 });

  expect(update).toHaveBeenCalledTimes(1);
  expect(info).not.toHaveBeenCalled();
});

test("returns tenant-local not found without a successful business log", async () => {
  const update = mock(async () => ({ state: "not_found" as const }));
  const { logger, info } = loggingHarness();
  const service = new UpdateUserService({ update }, logger);

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      { name: "Updated" },
      versionPrecondition,
      context,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

  expect(update).toHaveBeenCalledTimes(1);
  expect(info).not.toHaveBeenCalled();
});

test("rejects an empty direct service update before repository access or business log", async () => {
  const update = mock(async () => ({ state: "not_found" as const }));
  const { logger, info } = loggingHarness();
  const service = new UpdateUserService({ update }, logger);

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      {},
      versionPrecondition,
      context,
    ),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  expect(update).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

test("rejects missing write scope before repository access or business log", async () => {
  const update = mock(async () => ({ state: "not_found" as const }));
  const { logger, info } = loggingHarness();
  const service = new UpdateUserService({ update }, logger);
  const readOnly: RequestContext = {
    ...context,
    principal: {
      subject: "user-123",
      tenantId: "tenant-a",
      scopes: ["users:read"],
    },
  };

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      { name: "Updated" },
      versionPrecondition,
      readOnly,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(update).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});
