import { expect, test } from "bun:test";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

const root = new URL("../../../", import.meta.url);
const localDatabaseDefault = "$" + "{DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app}";
const e2eResultExpression = "$" + "{{ needs.e2e.result }}";

async function readText(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

test("package scripts expose standalone and full-CI E2E commands", async () => {
  const packageJson = JSON.parse(await readText("package.json")) as PackageJson;

  expect(packageJson.scripts?.["test:e2e"]).toBe("bun test tests/e2e");
  expect(packageJson.scripts?.["ci:e2e"]).toBe("bun run db:migrate && bun run test:e2e");
  expect(packageJson.scripts?.ci).toBe(
    "bun run check && bun run test:coverage && bun run ci:integration && bun run test:e2e",
  );
});

test("just exposes the E2E test command", async () => {
  const justfile = await readText("justfile");

  expect(justfile).toContain(
    `test-e2e:\n  DATABASE_URL=${localDatabaseDefault} bun run test:e2e\n`,
  );
});

test("GitHub Actions makes E2E an independent required job", async () => {
  const workflow = await readText(".github/workflows/ci.yml");

  expect(workflow).toContain("  e2e:\n");
  expect(workflow).toContain("- run: bun run ci:e2e\n");
  expect(workflow).toContain("needs: [quality, integration, coverage, e2e]");
  expect(workflow).toContain(`E2E_RESULT: ${e2eResultExpression}`);
  expect(workflow).toContain('test "$E2E_RESULT" = "success"');
});
