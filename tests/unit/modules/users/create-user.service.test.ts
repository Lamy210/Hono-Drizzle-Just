import { expect, mock, spyOn, test } from "bun:test";
import type { UserRepository } from "../../../../src/modules/users/domain/user.repository";
import { CreateUserService } from "../../../../src/modules/users/application/create-user.service";
import { JsonConsoleLogger } from "../../../../src/infrastructure/logging/json-console-logger";
import type { RequestContext } from "../../../../src/core/context/request-context";

const context: RequestContext = {
  requestId: "550e8400-e29b-41d4-a716-446655440000",
  trace: {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  },
  startedAt: 0,
};

test("service uses a mocked repository and logs the created user", async () => {
  const createdAt = new Date("2026-09-13T00:00:00.000Z");
  const findByEmail = mock(async () => null);
  const create = mock(async (input: { email: string; name: string }) => ({
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: input.email,
    name: input.name,
    createdAt,
  }));
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail,
    create,
  };
  const logger = new JsonConsoleLogger({}, () => undefined);
  const infoSpy = spyOn(logger, "info");
  const service = new CreateUserService(repository, logger);

  const user = await service.execute({ email: "lamy@example.com", name: "Lamy" }, context);

  expect(findByEmail).toHaveBeenCalledWith("lamy@example.com");
  expect(create).toHaveBeenCalledWith({ email: "lamy@example.com", name: "Lamy" });
  expect(user.email).toBe("lamy@example.com");
  expect(infoSpy).toHaveBeenCalledTimes(1);
});

test("service rejects an already registered email", async () => {
  const existing = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: "lamy@example.com",
    name: "Lamy",
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
  };
  const create = mock(async () => existing);
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => existing),
    create,
  };
  const service = new CreateUserService(repository, new JsonConsoleLogger({}, () => undefined));

  await expect(
    service.execute({ email: "lamy@example.com", name: "Lamy" }, context),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  expect(create).not.toHaveBeenCalled();
});
