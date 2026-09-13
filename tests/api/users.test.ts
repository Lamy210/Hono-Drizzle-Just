import { expect, mock, test } from "bun:test";
import { createApp } from "../../src/app/app";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../src/modules/users/application/create-user.service";
import { GetUserService } from "../../src/modules/users/application/get-user.service";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";

function buildApp() {
  const user = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    email: "lamy@example.com",
    name: "Lamy",
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
  };
  const repository: UserRepository = {
    findById: mock(async () => user),
    findByEmail: mock(async () => null),
    create: mock(async (input) => ({ ...user, ...input })),
  };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  return {
    app: createApp({
      logger,
      createUserService: new CreateUserService(repository, logger),
      getUserService: new GetUserService(repository),
    }),
    repository,
  };
}

test("invalid request body returns the common validation error schema", async () => {
  const { app } = buildApp();
  const response = await app.request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", name: "Lamy" }),
  });

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  expect(typeof body.requestId).toBe("string");
  expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
});

test("uppercase UUID path input is accepted and normalized before repository access", async () => {
  const { app, repository } = buildApp();
  const response = await app.request("/users/550E8400-E29B-41D4-A716-446655440000");

  expect(response.status).toBe(200);
  expect(repository.findById).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440000");
  const body = await response.json();
  expect(body.id).toBe("550e8400-e29b-41d4-a716-446655440000");
});

test("valid incoming traceparent keeps the trace ID and emits a new span ID", async () => {
  const { app } = buildApp();
  const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const response = await app.request("/health", { headers: { traceparent: incoming } });

  expect(response.status).toBe(200);
  const outgoing = response.headers.get("traceparent");
  expect(outgoing).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  expect(outgoing).not.toBe(incoming);
});
