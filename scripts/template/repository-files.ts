import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_TEMPLATE_IDENTITY, type TemplateIdentity } from "./identity";

export const MANAGED_IDENTITY_PATHS = [
  "package.json",
  "bun.lock",
  "README.md",
  ".env.example",
  "src/config/config.schema.ts",
  "tests/unit/config/load-config.test.ts",
] as const;

export type ManagedIdentityPath = (typeof MANAGED_IDENTITY_PATHS)[number];

export interface ManagedRepositorySnapshot {
  readonly root: string;
  readonly files: Readonly<Record<ManagedIdentityPath, string>>;
}

export interface PlannedFileChange {
  readonly path: Exclude<ManagedIdentityPath, "bun.lock">;
  readonly content: string;
}

export type RepositoryIdentityState = "pristine" | "target" | "mixed";

const SOURCE_README_DESCRIPTION =
  "Reusable backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.";

function targetReadmeDescription(identity: TemplateIdentity): string {
  return `Backend API template for ${identity.displayName}, built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.`;
}

function repositoryUrls(identity: TemplateIdentity) {
  return {
    repository: `git+https://github.com/${identity.repositorySlug}.git`,
    bugs: `https://github.com/${identity.repositorySlug}/issues`,
    homepage: `https://github.com/${identity.repositorySlug}#readme`,
  };
}

interface PackageIdentity {
  readonly name: string | undefined;
  readonly repositoryUrl: string | undefined;
  readonly bugsUrl: string | undefined;
  readonly homepage: string | undefined;
}

function readPackageIdentity(text: string): PackageIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("package.json must contain valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json must contain a JSON object");
  }
  const packageJson = parsed as Record<string, unknown>;
  const repository = packageJson.repository;
  const bugs = packageJson.bugs;
  return {
    name: typeof packageJson.name === "string" ? packageJson.name : undefined,
    repositoryUrl:
      repository && typeof repository === "object" && !Array.isArray(repository)
        ? typeof (repository as Record<string, unknown>).url === "string"
          ? ((repository as Record<string, unknown>).url as string)
          : undefined
        : undefined,
    bugsUrl:
      bugs && typeof bugs === "object" && !Array.isArray(bugs)
        ? typeof (bugs as Record<string, unknown>).url === "string"
          ? ((bugs as Record<string, unknown>).url as string)
          : undefined
        : undefined,
    homepage: typeof packageJson.homepage === "string" ? packageJson.homepage : undefined,
  };
}

function exactlyOneMatch(text: string, pattern: RegExp, label: string): RegExpExecArray {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const matches = [...text.matchAll(globalPattern)];
  if (matches.length !== 1) {
    throw new Error(`${label} must have exactly one managed match; found ${matches.length}`);
  }
  const match = matches[0];
  if (!match) {
    throw new Error(`${label} managed match is unavailable`);
  }
  return match;
}

function readEnvServiceName(text: string): string {
  const match = exactlyOneMatch(text, /^SERVICE_NAME=([^\r\n]*)$/m, ".env.example SERVICE_NAME");
  return match[1] ?? "";
}

function readConfigServiceName(text: string): string {
  const match = exactlyOneMatch(
    text,
    /SERVICE_NAME:\s*z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)\.default\("([^"]+)"\)/,
    "config SERVICE_NAME default",
  );
  return match[1] ?? "";
}

function readConfigTestServiceName(text: string): string {
  const match = exactlyOneMatch(
    text,
    /serviceName:\s*"([^"]+)"/,
    "config test serviceName assertion",
  );
  return match[1] ?? "";
}

interface ReadmeIdentity {
  readonly displayName: string;
  readonly description: string;
}

function readReadmeIdentity(text: string): ReadmeIdentity {
  const match = /^(?:\uFEFF)?# ([^\r\n]+)\r?\n\r?\n([^\r\n]+)(?:\r?\n|$)/.exec(text);
  if (!match?.[1] || !match[2]) {
    throw new Error("README.md must start with one H1 and one-line opening description");
  }
  return { displayName: match[1], description: match[2] };
}

export function readLockfileRootName(text: string): string | undefined {
  const match = /"workspaces"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/.exec(text);
  return match?.[1];
}

export async function readManagedRepository(root: string): Promise<ManagedRepositorySnapshot> {
  const entries = await Promise.all(
    MANAGED_IDENTITY_PATHS.map(async (path) => [path, await readFile(join(root, path), "utf8")] as const),
  );
  const files = Object.fromEntries(entries) as Record<ManagedIdentityPath, string>;

  readPackageIdentity(files["package.json"]);
  if (!readLockfileRootName(files["bun.lock"])) {
    throw new Error("bun.lock root workspace name is missing");
  }
  readReadmeIdentity(files["README.md"]);
  readEnvServiceName(files[".env.example"]);
  readConfigServiceName(files["src/config/config.schema.ts"]);
  readConfigTestServiceName(files["tests/unit/config/load-config.test.ts"]);

  return { root, files };
}

function snapshotMatches(snapshot: ManagedRepositorySnapshot, identity: TemplateIdentity): boolean {
  const packageIdentity = readPackageIdentity(snapshot.files["package.json"]);
  const urls = repositoryUrls(identity);
  const readme = readReadmeIdentity(snapshot.files["README.md"]);
  const expectedDescription =
    identity.repositorySlug === SOURCE_TEMPLATE_IDENTITY.repositorySlug &&
    identity.packageName === SOURCE_TEMPLATE_IDENTITY.packageName &&
    identity.serviceName === SOURCE_TEMPLATE_IDENTITY.serviceName &&
    identity.displayName === SOURCE_TEMPLATE_IDENTITY.displayName
      ? SOURCE_README_DESCRIPTION
      : targetReadmeDescription(identity);

  return (
    packageIdentity.name === identity.packageName &&
    packageIdentity.repositoryUrl === urls.repository &&
    packageIdentity.bugsUrl === urls.bugs &&
    packageIdentity.homepage === urls.homepage &&
    readLockfileRootName(snapshot.files["bun.lock"]) === identity.packageName &&
    readme.displayName === identity.displayName &&
    readme.description === expectedDescription &&
    readEnvServiceName(snapshot.files[".env.example"]) === identity.serviceName &&
    readConfigServiceName(snapshot.files["src/config/config.schema.ts"]) === identity.serviceName &&
    readConfigTestServiceName(snapshot.files["tests/unit/config/load-config.test.ts"]) ===
      identity.serviceName
  );
}

export function classifyRepositoryState(
  snapshot: ManagedRepositorySnapshot,
  target: TemplateIdentity,
): RepositoryIdentityState {
  if (snapshotMatches(snapshot, target)) {
    return "target";
  }
  if (snapshotMatches(snapshot, SOURCE_TEMPLATE_IDENTITY)) {
    return "pristine";
  }
  return "mixed";
}

function updatePackageJson(text: string, target: TemplateIdentity): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const urls = repositoryUrls(target);
  const currentRepository =
    parsed.repository && typeof parsed.repository === "object" && !Array.isArray(parsed.repository)
      ? (parsed.repository as Record<string, unknown>)
      : {};
  const currentBugs =
    parsed.bugs && typeof parsed.bugs === "object" && !Array.isArray(parsed.bugs)
      ? (parsed.bugs as Record<string, unknown>)
      : {};

  parsed.name = target.packageName;
  parsed.repository = { ...currentRepository, type: "git", url: urls.repository };
  parsed.bugs = { ...currentBugs, url: urls.bugs };
  parsed.homepage = urls.homepage;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function updateReadme(text: string, target: TemplateIdentity): string {
  const readme = readReadmeIdentity(text);
  if (
    readme.displayName !== SOURCE_TEMPLATE_IDENTITY.displayName ||
    readme.description !== SOURCE_README_DESCRIPTION
  ) {
    throw new Error("README.md opening identity is not the pristine template identity");
  }
  return text.replace(
    /^(?:\uFEFF)?# [^\r\n]+\r?\n\r?\n[^\r\n]+/,
    `# ${target.displayName}\n\n${targetReadmeDescription(target)}`,
  );
}

function replaceExactlyOnce(text: string, pattern: RegExp, replacement: string, label: string): string {
  exactlyOneMatch(text, pattern, label);
  return text.replace(pattern, replacement);
}

export function planIdentityChanges(
  snapshot: ManagedRepositorySnapshot,
  target: TemplateIdentity,
): PlannedFileChange[] {
  const state = classifyRepositoryState(snapshot, target);
  if (state === "target") {
    return [];
  }
  if (state === "mixed") {
    throw new Error("repository identity is mixed or unsupported; refusing to initialize");
  }

  return [
    { path: "package.json", content: updatePackageJson(snapshot.files["package.json"], target) },
    { path: "README.md", content: updateReadme(snapshot.files["README.md"], target) },
    {
      path: ".env.example",
      content: replaceExactlyOnce(
        snapshot.files[".env.example"],
        /^SERVICE_NAME=hono-drizzle-just$/m,
        `SERVICE_NAME=${target.serviceName}`,
        ".env.example SERVICE_NAME",
      ),
    },
    {
      path: "src/config/config.schema.ts",
      content: replaceExactlyOnce(
        snapshot.files["src/config/config.schema.ts"],
        /SERVICE_NAME:\s*z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)\.default\("hono-drizzle-just"\)/,
        `SERVICE_NAME: z.string().trim().min(1).max(100).default("${target.serviceName}")`,
        "config SERVICE_NAME default",
      ),
    },
    {
      path: "tests/unit/config/load-config.test.ts",
      content: replaceExactlyOnce(
        snapshot.files["tests/unit/config/load-config.test.ts"],
        /serviceName:\s*"hono-drizzle-just"/,
        `serviceName: "${target.serviceName}"`,
        "config test serviceName assertion",
      ),
    },
  ];
}
