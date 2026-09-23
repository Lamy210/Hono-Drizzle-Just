import { expect, mock, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
import { ListUsersService } from "../../../../src/modules/users/application/list-users.service";
import type { UserListRepository } from "../../../../src/modules/users/application/user-list.repository";

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

test("lists only the authorized tenant page and derives pagination metadata", async () => {
  const user = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-a",
    email: "lamy@example.com",
    name: "Lamy",
    version: 1,
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
  };
  const listPage = mock(async () => ({ users: [user], total: 41 }));
  const repository: UserListRepository = { listPage };
  const service = new ListUsersService(repository);

  const result = await service.execute({ page: 3, perPage: 20 }, context);

  expect(listPage).toHaveBeenCalledWith("tenant-a", { offset: 40, limit: 20 });
  expect(result).toEqual({
    users: [user],
    meta: { page: 3, perPage: 20, total: 41, totalPages: 3 },
  });
});

test("empty user collection reports zero total pages", async () => {
  const repository: UserListRepository = {
    listPage: mock(async () => ({ users: [], total: 0 })),
  };
  const service = new ListUsersService(repository);

  const result = await service.execute({ page: 1, perPage: 20 }, context);

  expect(result.meta.totalPages).toBe(0);
  expect(result.users).toEqual([]);
});

test("authorization is enforced before listing tenant data", async () => {
  const listPage = mock(async () => ({ users: [], total: 0 }));
  const service = new ListUsersService({ listPage });
  const missingScope: RequestContext = {
    ...context,
    principal: {
      subject: "user-123",
      tenantId: "tenant-a",
      scopes: ["users:write"],
    },
  };

  await expect(service.execute({ page: 1, perPage: 20 }, missingScope)).rejects.toMatchObject({
    code: "FORBIDDEN",
    status: 403,
  });
  expect(listPage).not.toHaveBeenCalled();
});
