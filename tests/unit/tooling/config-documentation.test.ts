import { expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url);

async function readText(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function envKeys(text: string): string[] {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");
}

function configKeys(text: string): string[] {
  const start = text.indexOf("const RawConfigSchema = z");
  const end = text.indexOf(".superRefine(", start);
  if (start < 0 || end < 0) {
    throw new Error("RawConfigSchema boundaries are unavailable");
  }
  return [...text.slice(start, end).matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map(
    (match) => match[1] ?? "",
  );
}

function documentedConfigKeys(text: string): string[] {
  const start = text.indexOf("## Configuration");
  if (start < 0) {
    throw new Error("README Configuration section is unavailable");
  }
  const afterHeading = text.slice(start + "## Configuration".length);
  const nextHeading = afterHeading.search(/^## /m);
  const section = nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading);
  return [...section.matchAll(/^\|\s+`([A-Z][A-Z0-9_]*)`\s+\|/gm)].map(
    (match) => match[1] ?? "",
  );
}

test("runtime configuration, .env.example, and README configuration table stay synchronized", async () => {
  const [env, schema, readme] = await Promise.all([
    readText(".env.example"),
    readText("src/config/config.schema.ts"),
    readText("README.md"),
  ]);

  const envVariables = envKeys(env);
  const runtimeVariables = configKeys(schema);
  const documentedVariables = documentedConfigKeys(readme);

  expect(duplicateValues(envVariables)).toEqual([]);
  expect(duplicateValues(runtimeVariables)).toEqual([]);
  expect(duplicateValues(documentedVariables)).toEqual([]);

  expect(sortedUnique(envVariables)).toEqual(sortedUnique(runtimeVariables));
  expect(sortedUnique(documentedVariables)).toEqual(sortedUnique(runtimeVariables));
});
