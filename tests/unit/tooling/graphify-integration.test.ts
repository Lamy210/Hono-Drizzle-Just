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

test("Graphify stays outside the Bun dependency graph", async () => {
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
});
