import { expect, mock, test } from "bun:test";
import { createApp } from "../../../src/app/app";
import { ReadinessChecker } from "../../../src/core/health/readiness-checker";
import type { TransactionManager } from "../../../src/core/transaction/transaction-manager";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../../src/modules/users/application/create-user.service";
import { GetUserService } from "../../../src/modules/users/application/get-user.service";
import type { UserUnitOfWork } from "../../../src/modules/users/application/user-unit-of-work";
import type { UserRepository } from "../../../src/modules/users/domain/user.repository";
import { userUnitOfWork } from "../../helpers/user-unit-of-work";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

const root = new URL("../../../", import.meta.url);
const contractResultExpression = "$" + "{{ needs.contract.result }}";

async function readText(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

function buildContractApp() {
  const user = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    tenantId: "tenant-contract",
    email: "contract@example.com",
    name: "Contract User",
    createdAt: new Date("2026-09-16T00:00:00.000Z"),
  };
  const repository: UserRepository = {
    findById: mock(async () => user),
    findByEmail: mock(async () => null),
    create: mock(async (input) => ({ ...user, ...input })),
  };
  const transactions: TransactionManager<UserUnitOfWork> = {
    run: async (operation) => operation(userUnitOfWork(repository)),
  };
  const logger = new JsonConsoleLogger({ service: "openapi-contract-test" }, () => undefined);

  return createApp({
    logger,
    readinessChecker: new ReadinessChecker([]),
    createUserService: new CreateUserService(transactions, logger),
    getUserService: new GetUserService(repository),
  });
}

test("committed OpenAPI snapshot matches the runtime document", async () => {
  const snapshot = Bun.file(new URL("openapi/openapi.json", root));
  expect(await snapshot.exists()).toBe(true);

  const response = await buildContractApp().request("/openapi.json");
  expect(response.status).toBe(200);

  const committed = JSON.parse(await snapshot.text()) as unknown;
  expect(await response.json()).toEqual(committed);
});

test("package and just commands expose OpenAPI contract verification", async () => {
  const packageJson = JSON.parse(await readText("package.json")) as PackageJson;
  const justfile = await readText("justfile");

  expect(packageJson.scripts?.["openapi:generate"]).toBe("bun scripts/openapi/generate.ts");
  expect(packageJson.scripts?.["openapi:verify"]).toBe("bun scripts/openapi/verify.ts");
  expect(packageJson.scripts?.["openapi:lint"]).toContain("@redocly/cli");
  expect(packageJson.scripts?.["openapi:contract"]).toContain("openapi:verify");
  expect(packageJson.scripts?.ci).toContain("openapi:contract");
  expect(justfile).toContain("openapi-generate:\n  bun run openapi:generate\n");
  expect(justfile).toContain("openapi-verify:\n  bun run openapi:contract\n");
});

test("GitHub Actions makes contract verification independently required", async () => {
  const workflow = await readText(".github/workflows/ci.yml");

  expect(workflow).toContain("  contract:\n");
  expect(workflow).toContain("bun run openapi:contract");
  expect(workflow).toContain("scripts/openapi/oasdiff.sh breaking");
  expect(workflow).toContain("needs: [quality, integration, coverage, e2e, contract]");
  expect(workflow).toContain(`CONTRACT_RESULT: ${contractResultExpression}`);
  expect(workflow).toContain('test "$CONTRACT_RESULT" = "success"');
});
