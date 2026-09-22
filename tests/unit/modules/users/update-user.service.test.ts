import { expect, mock, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
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

test("normalizes partial updates and scopes them to the authorized tenant", async () => {
  const updated = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-a",
    email: "updated@example.com",
    name: "Updated",
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
  };
  const update = mock(async () => updated);
  const service = new UpdateUserService({ update });

  const result = await service.execute(
    "550E8400-E29B-41D4-A716-446655440000",
    { email: " UPDATED@Example.com ", name: " Updated " },
    context,
  );

  expect(update).toHaveBeenCalledWith(
    "tenant-a",
    "550e8400-e29b-41d4-a716-446655440000",
    { email: "updated@example.com", name: "Updated" },
  );
  expect(result).toEqual(updated);
});

test("returns tenant-local not found without a second existence probe", async () => {
  const update = mock(async () => null);
  const service = new UpdateUserService({ update });

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      { name: "Updated" },
      context,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

  expect(update).toHaveBeenCalledTimes(1);
});

test("rejects an empty direct service update before repository access", async () => {
  const update = mock(async () => null);
  const service = new UpdateUserService({ update });

  await expect(
    service.execute(
      "550e8400-e29b-41d4-a716-446655440000",
      {},
      context,
    ),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  expect(update).not.toHaveBeenCalled();
});

test("rejects missing write scope before repository access", async () => {
  const update = mock(async () => null);
  const service = new UpdateUserService({ update });
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
      readOnly,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  expect(update).not.toHaveBeenCalled();
});
