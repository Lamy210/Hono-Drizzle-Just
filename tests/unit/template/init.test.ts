import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTemplateIdentity, type TemplateIdentity } from "../../../scripts/template/identity";
import { initializeTemplate } from "../../../scripts/template/init-lib";
import type { CommandResult, CommandRunner } from "../../../scripts/template/process-runner";
import { MANAGED_IDENTITY_PATHS, readLockfileRootName } from "../../../scripts/template/repository-files";

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

## Using this template

Historical/reference text keeps Hono-Drizzle-Just unchanged.
`,
  ".env.example": "NODE_ENV=development\nSERVICE_NAME=hono-drizzle-just\nPORT=3000\n",
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

async function makeFixture(overrides: Partial<Record<ManagedPath, string>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hono-template-init-"));
  roots.push(root);
  const files: Record<ManagedPath, string> = { ...sourceFiles };
  for (const path of Object.keys(overrides) as ManagedPath[]) {
    const content = overrides[path];
    if (content !== undefined) files[path] = content;
  }
  for (const path of Object.keys(files) as ManagedPath[]) {
    const fullPath = join(root, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, files[path], "utf8");
  }
  return root;
}

async function capture(root: string): Promise<Record<ManagedPath, string>> {
  const entries = await Promise.all(
    (Object.keys(sourceFiles) as ManagedPath[]).map(async (path) => [path, await readFile(join(root, path), "utf8")] as const),
  );
  return Object.fromEntries(entries) as Record<ManagedPath, string>;
}

class LockfileRunner implements CommandRunner {
  readonly calls: Array<{ argv: readonly string[]; cwd: string }> = [];

  constructor(
    private readonly target: TemplateIdentity,
    private readonly mode: "success" | "command-failure" | "wrong-lockfile" = "success",
  ) {}

  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    this.calls.push({ argv: [...argv], cwd });
    expect(argv).toEqual(["bun", "install", "--lockfile-only"]);

    if (this.mode === "command-failure") {
      return { exitCode: 1, stdout: "", stderr: "simulated lockfile failure" };
    }

    if (this.mode === "success") {
      const path = join(cwd, "bun.lock");
      const lockfile = await readFile(path, "utf8");
      await writeFile(path, lockfile.replace("hono-drizzle-just-template", this.target.packageName), "utf8");
    }

    return { exitCode: 0, stdout: "lockfile updated", stderr: "" };
  }
}

const target = resolveTemplateIdentity({ repository: "acme/ExampleAPI", displayName: "Example API" });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("initializeTemplate", () => {
  test("initializes the pristine template and verifies the regenerated lockfile", async () => {
    const root = await makeFixture();
    const runner = new LockfileRunner(target);

    const result = await initializeTemplate({ root, target, dryRun: false, runner });

    expect(result.status).toBe("changed");
    expect(result.changedFiles).toContain("package.json");
    expect(result.changedFiles).toContain("bun.lock");
    expect(runner.calls).toEqual([{ argv: ["bun", "install", "--lockfile-only"], cwd: root }]);

    const files = await capture(root);
    expect(JSON.parse(files["package.json"])).toMatchObject({ name: "exampleapi" });
    expect(readLockfileRootName(files["bun.lock"])).toBe("exampleapi");
    expect(files[".env.example"]).toContain("SERVICE_NAME=example-api");
    expect(files["src/config/config.schema.ts"]).toContain('.default("example-api")');
    expect(files["tests/unit/config/load-config.test.ts"]).toContain('serviceName: "example-api"');
  });

  test("dry-run plans changes without writing or running Bun", async () => {
    const root = await makeFixture();
    const before = await capture(root);
    const runner = new LockfileRunner(target);

    const result = await initializeTemplate({ root, target, dryRun: true, runner });

    expect(result.status).toBe("dry-run");
    expect(result.changedFiles).toContain("bun.lock");
    expect(runner.calls).toEqual([]);
    expect(await capture(root)).toEqual(before);
  });

  test("rerunning the same identity is an unchanged no-op", async () => {
    const root = await makeFixture();
    const runner = new LockfileRunner(target);
    await initializeTemplate({ root, target, dryRun: false, runner });
    const callsAfterFirstRun = runner.calls.length;
    const beforeSecondRun = await capture(root);

    const result = await initializeTemplate({ root, target, dryRun: false, runner });

    expect(result).toEqual({ status: "unchanged", changedFiles: [] });
    expect(runner.calls).toHaveLength(callsAfterFirstRun);
    expect(await capture(root)).toEqual(beforeSecondRun);
  });

  test("rejects a different target after initialization before writing", async () => {
    const root = await makeFixture();
    const runner = new LockfileRunner(target);
    await initializeTemplate({ root, target, dryRun: false, runner });
    const before = await capture(root);
    const otherTarget = resolveTemplateIdentity({ repository: "other/OtherAPI" });
    const otherRunner = new LockfileRunner(otherTarget);

    await expect(
      initializeTemplate({ root, target: otherTarget, dryRun: false, runner: otherRunner }),
    ).rejects.toThrow(/mixed|unsupported/i);

    expect(otherRunner.calls).toEqual([]);
    expect(await capture(root)).toEqual(before);
  });

  test("rolls back every managed file when lockfile generation fails", async () => {
    const root = await makeFixture();
    const before = await capture(root);
    const runner = new LockfileRunner(target, "command-failure");

    await expect(initializeTemplate({ root, target, dryRun: false, runner })).rejects.toThrow(
      /lockfile/i,
    );

    expect(await capture(root)).toEqual(before);
  });

  test("rolls back when the regenerated lockfile does not match the target", async () => {
    const root = await makeFixture();
    const before = await capture(root);
    const runner = new LockfileRunner(target, "wrong-lockfile");

    await expect(initializeTemplate({ root, target, dryRun: false, runner })).rejects.toThrow(
      /lockfile/i,
    );

    expect(await capture(root)).toEqual(before);
  });

  test("the fixture covers every managed identity path", () => {
    expect(new Set(Object.keys(sourceFiles))).toEqual(new Set(MANAGED_IDENTITY_PATHS));
  });
});
