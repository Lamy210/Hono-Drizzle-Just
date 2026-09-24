import { expect, mock, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
import { ListUsersCursorService } from "../../../../src/modules/users/application/list-users-cursor.service";

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
    scopes: ["users:read"],
  },
};

test("lists after a tenant-scoped cursor and derives the next position", async () => {
  const first = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-a",
    email: "first@example.com",
    name: "First",
    version: 1,
    createdAt: new Date("2026-09-24T00:00:00.000Z"),
  };
  const second = {
    ...first,
    id: "550e8400-e29b-41d4-a716-446655440001",
    email: "second@example.com",
    name: "Second",
    createdAt: new Date("2026-09-23T00:00:00.000Z"),
  };
  const after = {
    createdAt: new Date("2026-09-25T00:00:00.000Z"),
    id: "550e8400-e29b-41d4-a716-446655440099",
  };
  const listAfter = mock(async () => ({ users: [first, second], hasMore: true }));
  const service = new ListUsersCursorService({ listAfter });

  const result = await service.execute({ after, limit: 2 }, context);

  expect(listAfter).toHaveBeenCalledWith("tenant-a", { after, limit: 2 });
  expect(result).toEqual({
    users: [first, second],
    meta: {
      limit: 2,
      next: { createdAt: second.createdAt, id: second.id },
    },
  });
});

test("omits the next position on the final cursor page", async () => {
  const listAfter = mock(async () => ({ users: [], hasMore: false }));
  const service = new ListUsersCursorService({ listAfter });

  const result = await service.execute({ limit: 20 }, context);

  expect(result).toEqual({ users: [], meta: { limit: 20 } });
  expect(listAfter).toHaveBeenCalledWith("tenant-a", { limit: 20 });
});

test("authorization is enforced before cursor repository access", async () => {
  const listAfter = mock(async () => ({ users: [], hasMore: false }));
  const service = new ListUsersCursorService({ listAfter });
  const writeOnly: RequestContext = {
    ...context,
    principal: {
      subject: "user-123",
      tenantId: "tenant-a",
      scopes: ["users:write"],
    },
  };

  await expect(service.execute({ limit: 20 }, writeOnly)).rejects.toMatchObject({
    code: "FORBIDDEN",
    status: 403,
  });
  expect(listAfter).not.toHaveBeenCalled();
});
