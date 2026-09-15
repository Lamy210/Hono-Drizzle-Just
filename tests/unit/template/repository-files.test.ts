import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplateIdentity } from "../../../scripts/template/identity";
import {
  classifyRepositoryState,
  planIdentityChanges,
  readLockfileRootName,
  readManagedRepository,
} from "../../../scripts/template/repository-files";

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

Historical/reference text keeps Hono-Drizzle-Just and hono-drizzle-just-template unchanged.
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

async function makeFixture(overrides: Partial<Record<keyof typeof sourceFiles, string>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hono-template-test-"));
  roots.push(root);
  for (const [path, content] of Object.entries({ ...sourceFiles, ...overrides })) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed repository state", () => {
  test("recognizes the pristine source template", async () => {
    const root = await makeFixture();
    const snapshot = await readManagedRepository(root);
    const target = resolveTemplateIdentity({ repository: "acme/ExampleAPI", displayName: "Example API" });

    expect(classifyRepositoryState(snapshot, target)).toBe("pristine");
  });

  test("recognizes an exact requested target state", async () => {
    const target = resolveTemplateIdentity({ repository: "acme/ExampleAPI", displayName: "Example API" });
    const root = await makeFixture();
    const pristine = await readManagedRepository(root);
    const changes = planIdentityChanges(pristine, target);
    for (const change of changes) {
      await writeFile(join(root, change.path), change.content, "utf8");
    }
    await writeFile(
      join(root, "bun.lock"),
      sourceFiles["bun.lock"].replace("hono-drizzle-just-template", "exampleapi"),
      "utf8",
    );

    const snapshot = await readManagedRepository(root);
    expect(classifyRepositoryState(snapshot, target)).toBe("target");
  });

  test("rejects a partially customized mixed state", async () => {
    const packageJson = JSON.parse(sourceFiles["package.json"]);
    packageJson.name = "manually-changed";
    const root = await makeFixture({ "package.json": `${JSON.stringify(packageJson, null, 2)}\n` });
    const snapshot = await readManagedRepository(root);
    const target = resolveTemplateIdentity({ repository: "acme/ExampleAPI" });

    expect(classifyRepositoryState(snapshot, target)).toBe("mixed");
    expect(() => planIdentityChanges(snapshot, target)).toThrow(/mixed|unsupported/i);
  });

  test("plans only active identity fields and leaves later README references untouched", async () => {
    const root = await makeFixture();
    const snapshot = await readManagedRepository(root);
    const target = resolveTemplateIdentity({ repository: "acme/ExampleAPI", displayName: "Example API" });
    const changes = planIdentityChanges(snapshot, target);
    const byPath = new Map(changes.map((change) => [change.path, change.content]));

    expect(changes.map((change) => change.path).sort()).toEqual(
      [
        ".env.example",
        "README.md",
        "package.json",
        "src/config/config.schema.ts",
        "tests/unit/config/load-config.test.ts",
      ].sort(),
    );

    const packageJson = JSON.parse(byPath.get("package.json") ?? "{}");
    expect(packageJson).toMatchObject({
      name: "exampleapi",
      version: "0.1.0",
      private: true,
      repository: { type: "git", url: "git+https://github.com/acme/ExampleAPI.git" },
      bugs: { url: "https://github.com/acme/ExampleAPI/issues" },
      homepage: "https://github.com/acme/ExampleAPI#readme",
    });

    const readme = byPath.get("README.md") ?? "";
    expect(readme).toStartWith(
      "# Example API\n\nBackend API template for Example API, built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.\n",
    );
    expect(readme).toContain(
      "Historical/reference text keeps Hono-Drizzle-Just and hono-drizzle-just-template unchanged.",
    );
    expect(byPath.get(".env.example")).toContain("SERVICE_NAME=example-api\n");
    expect(byPath.get("src/config/config.schema.ts")).toContain('.default("example-api")');
    expect(byPath.get("tests/unit/config/load-config.test.ts")).toContain(
      'serviceName: "example-api"',
    );
  });

  test("fails closed when a managed anchor is duplicated", async () => {
    const root = await makeFixture({
      ".env.example": "SERVICE_NAME=hono-drizzle-just\nSERVICE_NAME=hono-drizzle-just\n",
    });

    await expect(readManagedRepository(root)).rejects.toThrow(/SERVICE_NAME/i);
  });
});

describe("readLockfileRootName", () => {
  test("reads the root workspace name", () => {
    expect(readLockfileRootName(sourceFiles["bun.lock"])).toBe("hono-drizzle-just-template");
  });

  test("returns undefined when the root workspace name is unavailable", () => {
    expect(readLockfileRootName('{ "workspaces": {} }')).toBeUndefined();
  });
});
