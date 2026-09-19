import { expect, mock, test } from "bun:test";
import { createApp } from "../../src/app/app";
import type { HealthCheck } from "../../src/core/health/health-check";
import { ReadinessChecker } from "../../src/core/health/readiness-checker";
import type { TransactionManager } from "../../src/core/transaction/transaction-manager";
import { Sha256StringDigester } from "../../src/infrastructure/crypto/sha256-string-digester";
import { JsonConsoleLogger } from "../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../src/modules/users/application/create-user.service";
import { GetUserService } from "../../src/modules/users/application/get-user.service";
import type { UserUnitOfWork } from "../../src/modules/users/application/user-unit-of-work";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";
import { userUnitOfWork } from "../helpers/user-unit-of-work";

function transactions(repository: UserRepository): TransactionManager<UserUnitOfWork> {
  return { run: async (operation) => operation(userUnitOfWork(repository)) };
}

function buildApp(healthCheck: HealthCheck) {
  const repository: UserRepository = {
    findById: mock(async () => null),
    findByEmail: mock(async () => null),
    create: mock(async (input) => ({
      id: crypto.randomUUID(),
      ...input,
      createdAt: new Date(),
    })),
  };
  const logger = new JsonConsoleLogger({ service: "test" }, () => undefined);
  return createApp({
    logger,
    readinessChecker: new ReadinessChecker([healthCheck]),
    createUserService: new CreateUserService(
      transactions(repository),
      logger,
      new Sha256StringDigester(),
    ),
    getUserService: new GetUserService(repository),
  });
}

test("API responses use a safe default security-header baseline", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });

  const response = await app.request("/health/live");

  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-dns-prefetch-control")).toBe("off");
  expect(response.headers.get("x-download-options")).toBe("noopen");
  expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(response.headers.get("x-permitted-cross-domain-policies")).toBe("none");
  expect(response.headers.get("x-xss-protection")).toBe("0");
  expect(response.headers.get("x-powered-by")).toBeNull();

  expect(response.headers.get("strict-transport-security")).toBeNull();
  expect(response.headers.get("cross-origin-resource-policy")).toBeNull();
  expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
  expect(response.headers.get("origin-agent-cluster")).toBeNull();
});

test("liveness stays healthy even when a critical dependency is down", async () => {
  const app = buildApp({
    name: "database",
    check: async () => {
      throw new Error("database unavailable");
    },
  });

  const response = await app.request("/health/live");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("readiness returns 200 when critical dependencies are available", async () => {
  const app = buildApp({ name: "database", check: async () => undefined });

  const response = await app.request("/health/ready");
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.status).toBe("ready");
  expect(body.checks.database.status).toBe("up");
});

test("readiness returns 503 instead of 500 when a critical dependency is down", async () => {
  const app = buildApp({
    name: "database",
    check: async () => {
      throw new Error("database unavailable");
    },
  });

  const response = await app.request("/health/ready");
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body.status).toBe("not_ready");
  expect(body.checks.database.status).toBe("down");
  expect(JSON.stringify(body)).not.toContain("database unavailable");
});