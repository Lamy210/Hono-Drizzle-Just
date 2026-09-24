import { expect, test } from "bun:test";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

const root = new URL("../../../", import.meta.url);

async function readText(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

test("package scripts expose fast, quality, and full CI verification layers", async () => {
  const packageJson = JSON.parse(await readText("package.json")) as PackageJson;

  expect(packageJson.scripts?.["check:fast"]).toBe(
    "bun run lint && bun run typecheck && bun run test",
  );
  expect(packageJson.scripts?.check).toBe("bun run db:migrations:verify && bun run check:fast");
  expect(packageJson.scripts?.["ci:integration"]).toBe(
    "bun run db:migrate && bun run test:integration",
  );
  expect(packageJson.scripts?.ci).toBe(
    "bun run check && bun run openapi:contract && bun run test:coverage && bun run ci:integration && bun run test:e2e",
  );
});

test("just exposes the same three verification layers", async () => {
  const justfile = await readText("justfile");
  const dollarSign = "$";

  expect(justfile).toContain("check-fast:\n  bun run check:fast\n");
  expect(justfile).toContain("check:\n  bun run check\n");
  expect(justfile).toContain(
    `ci:\n  DATABASE_URL=${dollarSign}{DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run ci\n`,
  );
});

test("GitHub Actions reuses shared quality and integration commands", async () => {
  const workflow = await readText(".github/workflows/ci.yml");

  expect(workflow).toContain("- run: bun run check\n");
  expect(workflow).toContain("- run: bun run ci:integration\n");
  expect(workflow).not.toContain("- run: bun run db:migrations:verify\n      - run: bun run lint\n");
  expect(workflow).not.toContain("- run: bun run db:migrate\n      - run: bun run test:integration\n");
});
