import { createApp } from "../../src/app/app";
import { ReadinessChecker } from "../../src/core/health/readiness-checker";
import type { TransactionManager } from "../../src/core/transaction/transaction-manager";
import { Sha256StringDigester } from "../../src/infrastructure/crypto/sha256-string-digester";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../src/modules/users/application/create-user.service";
import { DeleteUserService } from "../../src/modules/users/application/delete-user.service";
import { GetUserService } from "../../src/modules/users/application/get-user.service";
import { ListUsersService } from "../../src/modules/users/application/list-users.service";
import { UpdateUserService } from "../../src/modules/users/application/update-user.service";
import type { UserCreationIdempotencyRepository } from "../../src/modules/users/application/user-creation-idempotency.repository";
import type { UserUnitOfWork } from "../../src/modules/users/application/user-unit-of-work";
import type { UserListRepository } from "../../src/modules/users/application/user-list.repository";
import type { UserUpdateRepository } from "../../src/modules/users/application/user-update.repository";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";

function buildContractApp() {
  const user = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-contract",
    email: "contract@example.com",
    name: "Contract User",
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  };
  const repository: UserRepository & UserListRepository & UserUpdateRepository = {
    findById: async () => user,
    findByEmail: async () => null,
    listPage: async () => ({ users: [user], total: 1 }),
    update: async (_tenantId, _id, fields) => ({ ...user, ...fields }),
    create: async (input) => ({ ...user, ...input }),
  };
  const idempotency: UserCreationIdempotencyRepository = {
    claim: async () => ({ state: "claimed" }),
    complete: async () => undefined,
  };
  const transactions: TransactionManager<UserUnitOfWork> = {
    run: async (operation) =>
      operation({
        users: repository,
        userCreationIdempotency: idempotency,
      }),
  };
  const logger = new JsonConsoleLogger({ service: "openapi-contract" }, () => undefined);

  return createApp({
    logger,
    readinessChecker: new ReadinessChecker([]),
    deleteUserService: new DeleteUserService({ deleteById: async () => false }),
    createUserService: new CreateUserService(
      transactions,
      logger,
      new Sha256StringDigester(),
    ),
    getUserService: new GetUserService(repository),
    listUsersService: new ListUsersService(repository),
    updateUserService: new UpdateUserService(repository),
  });
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalizeJson(nested)]),
  );
}

export async function renderOpenApiDocument(): Promise<string> {
  const response = await buildContractApp().request("/openapi.json");
  if (response.status !== 200) {
    throw new Error(`OpenAPI endpoint returned HTTP ${response.status}`);
  }

  const document = (await response.json()) as unknown;
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    (document as Record<string, unknown>).openapi !== "3.1.0"
  ) {
    throw new Error("OpenAPI endpoint did not return an OpenAPI 3.1.0 document");
  }

  return `${JSON.stringify(canonicalizeJson(document), null, 2)}\n`;
}
