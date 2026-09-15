import { expect, test } from "bun:test";
import { createBunCommandRunner } from "../../../scripts/template/process-runner";

test("production command runner executes an explicit argv array", async () => {
  const runner = createBunCommandRunner();
  const result = await runner.run(["bun", "--version"], process.cwd());

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  expect(result.stderr).toBe("");
});
