import { expect, mock, test } from "bun:test";
import type { RequestContext } from "../../../../src/core/context/request-context";
import { GetUserService } from "../../../../src/modules/users/application/get-user.service";
import type { User } from "../../../../src/modules/users/domain/user";
import type { UserRepository } from "../../../../src/modules/users/domain/user.repository";

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
    tenantId: "Tenant-A",
    scopes: ["users:read"],
  },
};

const user: User = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  tenantId: "Tenant-A",
  email: "lamy@example.com",
  name: "Lamy",
  version: 1,
  createdAt: new Date("2026-09-13T00:00:00.000Z"),
};

function serviceWith(findById: ReturnType<typeof mock>) {
  const repository: UserRepository = {
    findById,
    findByEmail: mock(async () => null),
    create: mock(async (input) => ({ id: crypto.randomUUID(), createdAt: new Date(), ...input })),
  };
  return new GetUserService(repository);
}

async function executeWithContext(
  service: GetUserService,
  id: string,
  requestContext: RequestContext,
): Promise<User> {
  const execute = service.execute as unknown as (
    userId: string,
    context: RequestContext,
  ) => Promise<User>;
  return execute.call(service, id, requestContext);
}

test("authorized reads preserve tenant case and canonicalize the UUID", async () => {
  const findById = mock(async () => user);
  const service = serviceWith(findById);

  await expect(
    executeWithContext(service, "550E8400-E29B-41D4-A716-446655440000", context),
  ).resolves.toEqual(user);
  expect(findById).toHaveBeenCalledWith("Tenant-A", "550e8400-e29b-41d4-a716-446655440000");
});

test("cross-tenant or unknown rows surface only tenant-local NOT_FOUND", async () => {
  const findById = mock(async () => null);
  const service = serviceWith(findById);

  await expect(executeWithContext(service, user.id, context)).rejects.toMatchObject({
    code: "NOT_FOUND",
    status: 404,
  });
  expect(findById).toHaveBeenCalledTimes(1);
  expect(findById).toHaveBeenCalledWith("Tenant-A", user.id);
});

test("anonymous and missing-scope reads are denied before repository access", async () => {
  for (const deniedContext of [
    { requestId: context.requestId, trace: context.trace, startedAt: context.startedAt },
    {
      ...context,
      principal: { subject: "user-123", tenantId: "Tenant-A", scopes: ["users:write"] },
    },
  ] satisfies RequestContext[]) {
    const findById = mock(async () => user);
    const service = serviceWith(findById);

    await expect(executeWithContext(service, user.id, deniedContext)).rejects.toMatchObject({
      status: expect.any(Number),
    });
    expect(findById).not.toHaveBeenCalled();
  }
});
