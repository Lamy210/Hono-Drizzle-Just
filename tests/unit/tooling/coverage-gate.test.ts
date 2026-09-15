import { expect, test } from "bun:test";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

const root = new URL("../../../", import.meta.url);

async function readText(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

test("Bun coverage config keeps reports and thresholds repository-owned", async () => {
  const bunfig = await readText("bunfig.toml");

  expect(bunfig).toContain("[test]\n");
  expect(bunfig).toContain('coverageReporter = ["text", "lcov"]');
  expect(bunfig).toContain('coverageDir = "coverage"');
  expect(bunfig).toContain("coverageSkipTestFiles = true");
  expect(bunfig).toContain("coverageThreshold = { line = 0.8, function = 0.75 }");
});

test("package and just commands expose the coverage gate", async () => {
  const packageJson = JSON.parse(await readText("package.json")) as PackageJson;
  const justfile = await readText("justfile");

  expect(packageJson.scripts?.["test:coverage"]).toBe(
    "bun test --coverage tests/unit tests/api",
  );
  expect(packageJson.scripts?.ci).toBe(
    "bun run check && bun run test:coverage && bun run ci:integration",
  );
  expect(justfile).toContain("coverage:\n  bun run test:coverage\n");
});

test("GitHub Actions makes coverage an independent required gate", async () => {
  const workflow = await readText(".github/workflows/ci.yml");

  expect(workflow).toContain("  coverage:\n");
  expect(workflow).toContain("      - run: bun run test:coverage\n");
  expect(workflow).toContain("      - run: test -s coverage/lcov.info\n");
  expect(workflow).toContain("    needs: [quality, integration, coverage]\n");
  expect(workflow).toContain("        COVERAGE_RESULT: ${{ needs.coverage.result }}\n");
  expect(workflow).toContain('        test "$COVERAGE_RESULT" = "success"\n');
});
