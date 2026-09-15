import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInitCli } from "../../../scripts/template/init";
import type { CommandResult, CommandRunner } from "../../../scripts/template/process-runner";

const roots: string[] = [];

const sourceFiles = {
  "package.json": `${JSON.stringify(
    {
      name: "hono-drizzle-just-template",
      version: "0.1.0",
      private: true,
      repository: { type: "git", url: "git+https://github.com/Lamy210/Hono-Drizzle-Just.git" },
      bugs: { url: "https://github.com/Lamy210/Hono-Drizzle-Just/issues" },
      homepage: "https://github.com/Lamy210/Hono-Drizzle-Just#readme",
    },
    null,
    2,
  )}\n`,
  "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "hono-drizzle-just-template",
      "dependencies": {}
    }
  },
  "packages": {}
}\n`,
  "README.md": `# Hono-Drizzle-Just

Reusable backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.
`,
  ".env.example": "SERVICE_NAME=hono-drizzle-just\n",
  "src/config/config.schema.ts": `const RawConfigSchema = z.object({
  SERVICE_NAME: z.string().trim().min(1).max(100).default("hono-drizzle-just"),
});
`,
  "tests/unit/config/load-config.test.ts": `expect(config).toMatchObject({
  serviceName: "hono-drizzle-just",
});
`,
} as const;

type ManagedPath = keyof typeof sourceFiles;

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "hono-template-init-cli-"));
  roots.push(root);
  for (const path of Object.keys(sourceFiles) as ManagedPath[]) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, sourceFiles[path], "utf8");
  }
  return root;
}

class CliRunner implements CommandRunner {
  readonly calls: readonly string[][] extends never ? never : string[][] = [];

  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    this.calls.push([...argv]);
    if (argv[0] === "git") {
      return { exitCode: 0, stdout: "https://github.com/acme/ExampleAPI.git\n", stderr: "" };
    }
    if (argv[0] === "bun" && argv[1] === "install") {
      const packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const lockPath = join(cwd, "bun.lock");
      const lockfile = await readFile(lockPath, "utf8");
      await writeFile(
        lockPath,
        lockfile.replace("hono-drizzle-just-template", String(packageJson.name)),
        "utf8",
      );
      return { exitCode: 0, stdout: "updated\n", stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "unexpected command" };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("dry-run accepts explicit identity overrides and writes a plan only", async () => {
  const root = await makeFixture();
  const runner = new CliRunner();
  const out: string[] = [];
  const err: string[] = [];

  const exitCode = await runInitCli({
    argv: [
      "--repository",
      "acme/ExampleAPI",
      "--name",
      "Example API",
      "--package-name",
      "example-api",
      "--service-name",
      "example-api-service",
      "--dry-run",
    ],
    root,
    runner,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });

  expect(exitCode).toBe(0);
  expect(runner.calls).toEqual([]);
  expect(out.join("\n")).toContain("Dry run");
  expect(out.join("\n")).toContain("package.json");
  expect(err).toEqual([]);
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).name).toBe(
    "hono-drizzle-just-template",
  );
});

test("infers the repository from origin and reports changed files", async () => {
  const root = await makeFixture();
  const runner = new CliRunner();
  const out: string[] = [];

  const exitCode = await runInitCli({
    argv: [],
    root,
    runner,
    stdout: (line) => out.push(line),
    stderr: () => undefined,
  });

  expect(exitCode).toBe(0);
  expect(runner.calls[0]).toEqual(["git", "remote", "get-url", "origin"]);
  expect(runner.calls[1]).toEqual(["bun", "install", "--lockfile-only"]);
  expect(out.join("\n")).toContain("Initialized ExampleAPI");
  expect(out.join("\n")).toContain("bun.lock");
});

test("unknown options are usage errors and do not run commands", async () => {
  const root = await makeFixture();
  const runner = new CliRunner();
  const err: string[] = [];

  const exitCode = await runInitCli({
    argv: ["--unknown"],
    root,
    runner,
    stdout: () => undefined,
    stderr: (line) => err.push(line),
  });

  expect(exitCode).toBe(2);
  expect(runner.calls).toEqual([]);
  expect(err.join("\n")).toMatch(/unknown|option/i);
});

test("missing option values are usage errors", async () => {
  const root = await makeFixture();
  const runner = new CliRunner();

  const exitCode = await runInitCli({
    argv: ["--repository"],
    root,
    runner,
    stdout: () => undefined,
    stderr: () => undefined,
  });

  expect(exitCode).toBe(2);
  expect(runner.calls).toEqual([]);
});
