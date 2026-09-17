import { expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url);

function rootFile(path: string): Bun.BunFile {
  return Bun.file(new URL(path, root));
}

async function readText(path: string): Promise<string> {
  return rootFile(path).text();
}

test("Graphify integration pins the tool and keeps generated output local", async () => {
  const versionFile = rootFile(".graphify-version");
  const graphifyIgnoreFile = rootFile(".graphifyignore");

  expect(await versionFile.exists()).toBe(true);
  expect((await versionFile.text()).trim()).toBe("0.9.63");
  expect(await readText(".gitignore")).toContain("graphify-out/");

  expect(await graphifyIgnoreFile.exists()).toBe(true);
  const graphifyIgnore = await graphifyIgnoreFile.text();
  expect(graphifyIgnore).toContain("graphify-out/");
  expect(graphifyIgnore).toContain("docs/superpowers/plans/");
});

test("Graphify stays outside the Bun dependency graph and normal CI", async () => {
  const packageJson = JSON.parse(await readText("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];

  expect(names).not.toContain("graphify");
  expect(names).not.toContain("graphifyy");

  const workflow = (await readText(".github/workflows/ci.yml")).toLowerCase();
  expect(workflow).not.toContain("graphify");
  expect(workflow).not.toContain("setup-uv");
});

test("Graphify project Agent Skill is committed from the pinned release", async () => {
  const skill = rootFile(".agents/skills/graphify/SKILL.md");
  const stamp = rootFile(".agents/skills/graphify/.graphify_version");
  const updateReference = rootFile(".agents/skills/graphify/references/update.md");

  expect(await skill.exists()).toBe(true);
  expect(await skill.text()).toContain("graphify");
  expect(await stamp.exists()).toBe(true);
  expect((await stamp.text()).trim()).toBe((await readText(".graphify-version")).trim());
  expect(await updateReference.exists()).toBe(true);
});

test("Graphify commands and documentation are discoverable", async () => {
  const justfile = await readText("justfile");
  expect(justfile).toContain("graphify-build:\n  graphify .\n");
  expect(justfile).toContain("graphify-update:\n  graphify . --update\n");
  expect(justfile).toContain('graphify-query query:\n  graphify query "$1"\n');
  expect(justfile).not.toContain('graphify query "{{query}}"');
  expect(justfile).toContain("graphify-watch:\n  graphify . --watch\n");

  const guide = rootFile("docs/development/graphify.md");
  expect(await guide.exists()).toBe(true);
  const guideText = await guide.text();
  expect(guideText).toContain("graphifyy");
  expect(guideText).toContain("graphify install --project --platform agents");
  expect(guideText).toContain("multi_agent = true");
  expect(guideText).toContain("MCP");

  const readme = await readText("README.md");
  expect(readme).toContain("[Graphify developer workflow](docs/development/graphify.md)");
});
