import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_TEMPLATE_IDENTITY, parseGitHubRepository } from "./identity";
import type { CommandRunner } from "./process-runner";
import { readLockfileRootName } from "./repository-files";

export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorResult {
  readonly status: DoctorStatus;
  readonly check: string;
  readonly message: string;
}

export interface DoctorReport {
  readonly results: readonly DoctorResult[];
  readonly exitCode: 0 | 1 | 2;
}

const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SOURCE_README_DESCRIPTION =
  "Reusable backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.";

interface PackageMetadata {
  readonly name: string;
  readonly repositorySlug: string;
}

interface ServiceNames {
  readonly env: string;
  readonly runtime: string;
}

interface ReadmeIdentity {
  readonly heading: string;
  readonly description: string;
}

function result(status: DoctorStatus, check: string, message: string): DoctorResult {
  return { status, check, message };
}

async function readText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

function parsePackageMetadata(text: string | undefined):
  | { readonly metadata: PackageMetadata; readonly diagnostic: DoctorResult }
  | { readonly metadata: undefined; readonly diagnostic: DoctorResult } {
  if (text === undefined) {
    return {
      metadata: undefined,
      diagnostic: result("FAIL", "package-metadata", "package.json is missing or unreadable"),
    };
  }

  let packageJson: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    packageJson = parsed as Record<string, unknown>;
  } catch {
    return {
      metadata: undefined,
      diagnostic: result("FAIL", "package-metadata", "package.json is not valid JSON metadata"),
    };
  }

  const name = packageJson.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 214 ||
    name !== name.toLowerCase() ||
    !PACKAGE_NAME_PATTERN.test(name)
  ) {
    return {
      metadata: undefined,
      diagnostic: result("FAIL", "package-metadata", "package.json name is not a valid lowercase package name"),
    };
  }

  const repository = packageJson.repository;
  const bugs = packageJson.bugs;
  const homepage = packageJson.homepage;
  const repositoryUrl =
    repository && typeof repository === "object" && !Array.isArray(repository)
      ? (repository as Record<string, unknown>).url
      : undefined;
  const bugsUrl =
    bugs && typeof bugs === "object" && !Array.isArray(bugs)
      ? (bugs as Record<string, unknown>).url
      : undefined;

  if (typeof repositoryUrl !== "string" || typeof bugsUrl !== "string" || typeof homepage !== "string") {
    return {
      metadata: undefined,
      diagnostic: result("FAIL", "package-metadata", "repository, bugs, and homepage URLs must all be configured"),
    };
  }

  const repositorySlug = parseGitHubRepository(repositoryUrl.replace(/^git\+/, ""));
  if (!repositorySlug) {
    return {
      metadata: undefined,
      diagnostic: result("FAIL", "package-metadata", "repository URL is not a recognized GitHub repository"),
    };
  }

  const expectedRepository = `git+https://github.com/${repositorySlug}.git`;
  const expectedBugs = `https://github.com/${repositorySlug}/issues`;
  const expectedHomepage = `https://github.com/${repositorySlug}#readme`;
  if (
    repositoryUrl !== expectedRepository ||
    bugsUrl !== expectedBugs ||
    homepage !== expectedHomepage
  ) {
    return {
      metadata: undefined,
      diagnostic: result(
        "FAIL",
        "package-metadata",
        "repository, bugs, and homepage do not resolve to one canonical GitHub repository",
      ),
    };
  }

  return {
    metadata: { name, repositorySlug },
    diagnostic: result("PASS", "package-metadata", `${name} -> ${repositorySlug}`),
  };
}

function parseServiceNames(envText: string | undefined, configText: string | undefined):
  | { readonly names: ServiceNames; readonly diagnostic: DoctorResult }
  | { readonly names: undefined; readonly diagnostic: DoctorResult } {
  if (envText === undefined || configText === undefined) {
    return {
      names: undefined,
      diagnostic: result("FAIL", "service-name", ".env.example or config schema is missing or unreadable"),
    };
  }

  const envMatches = [...envText.matchAll(/^SERVICE_NAME=([^\r\n]*)$/gm)];
  const configMatches = [
    ...configText.matchAll(
      /SERVICE_NAME:\s*z\.string\(\)\.trim\(\)\.min\(1\)\.max\(100\)\.default\("([^"]+)"\)/g,
    ),
  ];
  if (envMatches.length !== 1 || configMatches.length !== 1) {
    return {
      names: undefined,
      diagnostic: result("FAIL", "service-name", "SERVICE_NAME must have exactly one env and runtime default"),
    };
  }

  const env = envMatches[0]?.[1] ?? "";
  const runtime = configMatches[0]?.[1] ?? "";
  if (!SERVICE_NAME_PATTERN.test(env) || env.length > 100 || !SERVICE_NAME_PATTERN.test(runtime)) {
    return {
      names: undefined,
      diagnostic: result("FAIL", "service-name", "SERVICE_NAME values must be valid lowercase service names"),
    };
  }
  if (env !== runtime) {
    return {
      names: { env, runtime },
      diagnostic: result("FAIL", "service-name", `.env.example uses ${env} but runtime default uses ${runtime}`),
    };
  }

  return {
    names: { env, runtime },
    diagnostic: result("PASS", "service-name", env),
  };
}

function parseReadmeIdentity(text: string | undefined):
  | { readonly identity: ReadmeIdentity; readonly diagnostic: DoctorResult }
  | { readonly identity: undefined; readonly diagnostic: DoctorResult } {
  if (text === undefined) {
    return {
      identity: undefined,
      diagnostic: result("FAIL", "readme-identity", "README.md is missing or unreadable"),
    };
  }
  const match = /^(?:\uFEFF)?# ([^\r\n]+)\r?\n\r?\n([^\r\n]+)(?:\r?\n|$)/.exec(text);
  if (!match?.[1] || !match[2]) {
    return {
      identity: undefined,
      diagnostic: result("FAIL", "readme-identity", "README must start with an H1 and opening description"),
    };
  }
  return {
    identity: { heading: match[1], description: match[2] },
    diagnostic: result("PASS", "readme-identity", match[1]),
  };
}

function checkTemplateIdentity(
  packageMetadata: PackageMetadata | undefined,
  serviceNames: ServiceNames | undefined,
  readmeIdentity: ReadmeIdentity | undefined,
): DoctorResult {
  if (!packageMetadata || !serviceNames || !readmeIdentity) {
    return result("FAIL", "template-identity", "active identity cannot be evaluated because another identity check failed");
  }

  const packageIsSource = packageMetadata.name === SOURCE_TEMPLATE_IDENTITY.packageName;
  const repositoryIsSource = packageMetadata.repositorySlug === SOURCE_TEMPLATE_IDENTITY.repositorySlug;
  const serviceIsSource = serviceNames.env === SOURCE_TEMPLATE_IDENTITY.serviceName;
  const readmeIsSource =
    readmeIdentity.heading === SOURCE_TEMPLATE_IDENTITY.displayName &&
    readmeIdentity.description === SOURCE_README_DESCRIPTION;
  const sourceFlags = [packageIsSource, repositoryIsSource, serviceIsSource, readmeIsSource];

  if (sourceFlags.every(Boolean)) {
    return result("PASS", "template-identity", "Repository is the pristine source template identity");
  }
  if (sourceFlags.some(Boolean)) {
    return result("FAIL", "template-identity", "source-template identity is mixed with customized active metadata");
  }
  return result("PASS", "template-identity", "Active repository identity is customized consistently");
}

function checkReadmeAgainstPackage(
  diagnostic: DoctorResult,
  identity: ReadmeIdentity | undefined,
  packageMetadata: PackageMetadata | undefined,
): DoctorResult {
  if (diagnostic.status === "FAIL" || !identity || !packageMetadata) {
    return diagnostic;
  }
  const packageIsSource =
    packageMetadata.name === SOURCE_TEMPLATE_IDENTITY.packageName &&
    packageMetadata.repositorySlug === SOURCE_TEMPLATE_IDENTITY.repositorySlug;
  const readmeIsSource =
    identity.heading === SOURCE_TEMPLATE_IDENTITY.displayName &&
    identity.description === SOURCE_README_DESCRIPTION;
  if (!packageIsSource && readmeIsSource) {
    return result("FAIL", "readme-identity", "README still uses the source-template opening identity");
  }
  return diagnostic;
}

function checkLockfile(lockfileText: string | undefined, packageMetadata: PackageMetadata | undefined): DoctorResult {
  if (lockfileText === undefined) {
    return result("FAIL", "lockfile-name", "bun.lock is missing or unreadable");
  }
  const lockName = readLockfileRootName(lockfileText);
  if (!lockName) {
    return result("FAIL", "lockfile-name", "bun.lock root workspace name is missing");
  }
  if (!packageMetadata) {
    return result("FAIL", "lockfile-name", `bun.lock uses ${lockName}, but package metadata is invalid`);
  }
  if (lockName !== packageMetadata.name) {
    return result("FAIL", "lockfile-name", `bun.lock uses ${lockName}, package.json uses ${packageMetadata.name}`);
  }
  return result("PASS", "lockfile-name", lockName);
}

async function checkBunVersion(root: string, runner: CommandRunner): Promise<DoctorResult> {
  const versionFile = await readText(root, ".bun-version");
  if (versionFile === undefined) {
    return result("FAIL", "bun-version", ".bun-version is missing or unreadable");
  }
  const expected = versionFile.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expected)) {
    return result("FAIL", "bun-version", ".bun-version does not contain one exact Bun version");
  }
  const command = await runner.run(["bun", "--version"], root);
  if (command.exitCode !== 0) {
    return result("FAIL", "bun-version", "bun --version failed");
  }
  const actual = command.stdout.trim();
  if (actual !== expected) {
    return result("FAIL", "bun-version", `Bun ${actual || "unknown"} does not match .bun-version ${expected}`);
  }
  return result("PASS", "bun-version", `Bun ${actual} matches .bun-version`);
}

async function checkGitOrigin(
  root: string,
  runner: CommandRunner,
  packageMetadata: PackageMetadata | undefined,
): Promise<DoctorResult> {
  const command = await runner.run(["git", "remote", "get-url", "origin"], root);
  if (command.exitCode !== 0) {
    return result("WARN", "git-origin", "origin is missing or unavailable; package metadata was not compared to git remote");
  }
  const originSlug = parseGitHubRepository(command.stdout.trim());
  if (!originSlug) {
    return result("WARN", "git-origin", "origin is not a recognized GitHub remote");
  }
  if (!packageMetadata) {
    return result("WARN", "git-origin", `origin is ${originSlug}, but package metadata is invalid`);
  }
  if (originSlug !== packageMetadata.repositorySlug) {
    return result(
      "WARN",
      "git-origin",
      `origin points to ${originSlug} while package metadata points to ${packageMetadata.repositorySlug}`,
    );
  }
  return result("PASS", "git-origin", originSlug);
}

export async function runDoctor(options: {
  readonly root: string;
  readonly runner: CommandRunner;
}): Promise<DoctorReport> {
  try {
    const [packageText, lockfileText, envText, configText, readmeText] = await Promise.all([
      readText(options.root, "package.json"),
      readText(options.root, "bun.lock"),
      readText(options.root, ".env.example"),
      readText(options.root, "src/config/config.schema.ts"),
      readText(options.root, "README.md"),
    ]);

    const packageCheck = parsePackageMetadata(packageText);
    const serviceCheck = parseServiceNames(envText, configText);
    const readmeCheck = parseReadmeIdentity(readmeText);
    const results: DoctorResult[] = [
      await checkBunVersion(options.root, options.runner),
      packageCheck.diagnostic,
      checkLockfile(lockfileText, packageCheck.metadata),
      serviceCheck.diagnostic,
      checkReadmeAgainstPackage(readmeCheck.diagnostic, readmeCheck.identity, packageCheck.metadata),
      checkTemplateIdentity(packageCheck.metadata, serviceCheck.names, readmeCheck.identity),
      await checkGitOrigin(options.root, options.runner, packageCheck.metadata),
    ];

    return {
      results,
      exitCode: results.some((item) => item.status === "FAIL") ? 1 : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      results: [result("FAIL", "doctor", `Doctor could not complete: ${message}`)],
      exitCode: 2,
    };
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export function formatDoctorSummary(results: readonly DoctorResult[]): string {
  const passed = results.filter((item) => item.status === "PASS").length;
  const warnings = results.filter((item) => item.status === "WARN").length;
  const failed = results.filter((item) => item.status === "FAIL").length;
  return `Doctor: ${passed} ${plural(passed, "passed", "passed")}, ${warnings} ${plural(warnings, "warning")}, ${failed} ${plural(failed, "failed", "failed")}`;
}

export function formatDoctorResult(item: DoctorResult): string {
  return `${item.status} ${item.check.padEnd(20)} ${item.message}`;
}
