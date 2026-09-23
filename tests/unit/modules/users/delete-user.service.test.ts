import { expect, mock, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
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

test("deletes only from the authorized tenant and canonicalizes the UUID", async () => {
  const deleteById = mock(async () => true);
  const service = new DeleteUserService({ deleteById });

  await service.execute(
    "550E8400-E29B-41D4-A716-446655440000",
    context,
  );

  expect(deleteById).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
  );
});

test("returns tenant-local not found without an existence probe", async () => {
  const deleteById = mock(async () => false);
  const service = new DeleteUserService({ deleteById });

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      context,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

  expect(deleteById).toHaveBeenCalledTimes(1);
});

test("rejects missing write scope before repository access", async () => {
  const deleteById = mock(async () => true);
  const service = new DeleteUserService({ deleteById });
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
});
