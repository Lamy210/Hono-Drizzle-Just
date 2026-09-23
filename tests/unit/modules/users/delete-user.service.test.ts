import { expect, mock, spyOn, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";
import { DeleteUserService } from "../../../../src/modules/users/application/delete-user.service";

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

function loggingHarness() {
  const logger = new JsonConsoleLogger({}, () => undefined);
  return { logger, info: spyOn(logger, "info") };
}

test("deletes only from the authorized tenant and logs the canonical user identifier", async () => {
  const deleteById = mock(async () => true);
  const { logger, info } = loggingHarness();
  const service = new DeleteUserService({ deleteById }, logger);

  await service.execute(
    "550E8400-E29B-41D4-A716-446655440000",
    context,
  );

  const userId = "550e8400-e29b-41d4-a716-446655440000";
  expect(deleteById).toHaveBeenCalledWith("tenant-a", userId);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("user.deleted", {
    userId,
    requestId: context.requestId,
    traceId: context.trace.traceId,
  });
  expect(JSON.stringify(info.mock.calls)).not.toContain("tenant-a");
});

test("returns tenant-local not found without an existence probe or business log", async () => {
  const deleteById = mock(async () => false);
  const { logger, info } = loggingHarness();
  const service = new DeleteUserService({ deleteById }, logger);

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      context,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

  expect(deleteById).toHaveBeenCalledTimes(1);
  expect(info).not.toHaveBeenCalled();
});

test("rejects missing write scope before repository access or business log", async () => {
  const deleteById = mock(async () => true);
  const { logger, info } = loggingHarness();
  const service = new DeleteUserService({ deleteById }, logger);
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
      readOnly,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

  expect(deleteById).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});
