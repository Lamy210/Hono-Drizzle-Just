import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatDoctorSummary,
  runDoctor,
  type DoctorResult,
} from "../../../scripts/template/doctor-lib";
import { runDoctorCli } from "../../../scripts/template/doctor";
import type { CommandResult, CommandRunner } from "../../../scripts/template/process-runner";

const roots: string[] = [];

const initializedFiles = {
  ".bun-version": "1.4.2\n",
  "package.json": `${JSON.stringify(
    {
      name: "example-api",
      version: "0.1.0",
      private: true,
      repository: { type: "git", url: "git+https://github.com/acme/ExampleAPI.git" },
      bugs: { url: "https://github.com/acme/ExampleAPI/issues" },
      homepage: "https://github.com/acme/ExampleAPI#readme",
    },
    null,
    2,
  )}\n`,
  "bun.lock": `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example-api",
      "dependencies": {}
    }
  },
  "packages": {}
}\n`,
  "README.md": `# Example API

Backend API template for Example API, built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.
`,
  ".env.example": "NODE_ENV=development\nSERVICE_NAME=example-api\nPORT=3000\n",
  "src/config/config.schema.ts": `const RawConfigSchema = z.object({
  SERVICE_NAME: z.string().trim().min(1).max(100).default("example-api"),
});
`,
} as const;

type FixturePath = keyof typeof initializedFiles;

async function makeFixture(overrides: Partial<Record<FixturePath, string>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hono-template-doctor-"));
  roots.push(root);
  const files: Record<FixturePath, string> = { ...initializedFiles };
  for (const path of Object.keys(overrides) as FixturePath[]) {
    const content = overrides[path];
    if (content !== undefined) files[path] = content;
  }
  for (const path of Object.keys(files) as FixturePath[]) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, files[path], "utf8");
  }
  return root;
}

class DoctorRunner implements CommandRunner {
  constructor(
    private readonly origin: string | undefined = "https://github.com/acme/ExampleAPI.git",
    private readonly bunVersion = "1.4.2",
  ) {}

  async run(argv: readonly string[]): Promise<CommandResult> {
    if (argv.join(" ") === "bun --version") {
      return { exitCode: 0, stdout: `${this.bunVersion}\n`, stderr: "" };
    }
    if (argv.join(" ") === "git remote get-url origin") {
      return this.origin === undefined
        ? { exitCode: 2, stdout: "", stderr: "origin missing" }
        : { exitCode: 0, stdout: `${this.origin}\n`, stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: "unexpected command" };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function findResult(results: readonly DoctorResult[], check: string): DoctorResult {
  const result = results.find((candidate) => candidate.check === check);
  if (!result) throw new Error(`missing doctor result ${check}`);
  return result;
}

describe("runDoctor", () => {
  test("fully initialized repository returns only PASS results", async () => {
    const root = await makeFixture();
    const report = await runDoctor({ root, runner: new DoctorRunner() });

    expect(report.exitCode).toBe(0);
    expect(report.results.every((result) => result.status === "PASS")).toBe(true);
    expect(findResult(report.results, "lockfile-name").message).toContain("example-api");
    expect(findResult(report.results, "git-origin").message).toContain("acme/ExampleAPI");
  });

  test("package and lockfile name mismatch is FAIL", async () => {
    const root = await makeFixture({
      "bun.lock": initializedFiles["bun.lock"].replace('"name": "example-api"', '"name": "other-api"'),
    });
    const report = await runDoctor({ root, runner: new DoctorRunner() });

    expect(report.exitCode).toBe(1);
    expect(findResult(report.results, "lockfile-name").status).toBe("FAIL");
  });

  test("env and runtime service name mismatch is FAIL", async () => {
    const root = await makeFixture({
      ".env.example": initializedFiles[".env.example"].replace("SERVICE_NAME=example-api", "SERVICE_NAME=other-api"),
    });
    const report = await runDoctor({ root, runner: new DoctorRunner() });

    expect(report.exitCode).toBe(1);
    expect(findResult(report.results, "service-name").status).toBe("FAIL");
  });

  test("inconsistent GitHub package URLs are FAIL", async () => {
    const packageJson = JSON.parse(initializedFiles["package.json"]);
    packageJson.bugs.url = "https://github.com/other/Repo/issues";
    const root = await makeFixture({ "package.json": `${JSON.stringify(packageJson, null, 2)}\n` });
    const report = await runDoctor({ root, runner: new DoctorRunner() });

    expect(report.exitCode).toBe(1);
    expect(findResult(report.results, "package-metadata").status).toBe("FAIL");
  });

  test("missing origin is WARN only", async () => {
    const root = await makeFixture();
    const report = await runDoctor({ root, runner: new DoctorRunner(undefined) });

    expect(report.exitCode).toBe(0);
    expect(findResult(report.results, "git-origin").status).toBe("WARN");
  });

  test("recognized origin mismatch is WARN only", async () => {
    const root = await makeFixture();
    const report = await runDoctor({
      root,
      runner: new DoctorRunner("git@github.com:fork-owner/ExampleAPI.git"),
    });

    expect(report.exitCode).toBe(0);
    expect(findResult(report.results, "git-origin").status).toBe("WARN");
  });

  test("pristine source repository is reported as a valid source template", async () => {
    const packageJson = JSON.parse(initializedFiles["package.json"]);
    packageJson.name = "hono-drizzle-just-template";
    packageJson.repository.url = "git+https://github.com/Lamy210/Hono-Drizzle-Just.git";
    packageJson.bugs.url = "https://github.com/Lamy210/Hono-Drizzle-Just/issues";
    packageJson.homepage = "https://github.com/Lamy210/Hono-Drizzle-Just#readme";
    const root = await makeFixture({
      "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
      "bun.lock": initializedFiles["bun.lock"].replace("example-api", "hono-drizzle-just-template"),
      "README.md": "# Hono-Drizzle-Just\n\nReusable backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.\n",
      ".env.example": "SERVICE_NAME=hono-drizzle-just\n",
      "src/config/config.schema.ts": `const RawConfigSchema = z.object({\n  SERVICE_NAME: z.string().trim().min(1).max(100).default("hono-drizzle-just"),\n});\n`,
    });
    const report = await runDoctor({
      root,
      runner: new DoctorRunner("https://github.com/Lamy210/Hono-Drizzle-Just.git"),
    });

    expect(report.exitCode).toBe(0);
    expect(findResult(report.results, "template-identity")).toMatchObject({ status: "PASS" });
    expect(findResult(report.results, "template-identity").message).toMatch(/source template/i);
  });
});

test("summary counts PASS WARN and FAIL stably", () => {
  expect(
    formatDoctorSummary([
      { status: "PASS", check: "a", message: "ok" },
      { status: "PASS", check: "b", message: "ok" },
      { status: "WARN", check: "c", message: "review" },
      { status: "FAIL", check: "d", message: "broken" },
    ]),
  ).toBe("Doctor: 2 passed, 1 warning, 1 failed");
});

test("doctor CLI prints line-oriented results and summary", async () => {
  const root = await makeFixture();
  const out: string[] = [];

  const exitCode = await runDoctorCli({
    root,
    runner: new DoctorRunner(),
    stdout: (line) => out.push(line),
    stderr: () => undefined,
  });

  expect(exitCode).toBe(0);
  expect(out.some((line) => line.startsWith("PASS bun-version"))).toBe(true);
  expect(out.at(-1)).toMatch(/^Doctor: \d+ passed, \d+ warnings?, 0 failed$/);
});
