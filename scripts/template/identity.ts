export interface TemplateIdentity {
  readonly displayName: string;
  readonly packageName: string;
  readonly serviceName: string;
  readonly repositorySlug: string;
}

export interface IdentityInput {
  readonly repository?: string;
  readonly displayName?: string;
  readonly packageName?: string;
  readonly serviceName?: string;
}

export const SOURCE_TEMPLATE_IDENTITY: TemplateIdentity = Object.freeze({
  displayName: "Hono-Drizzle-Just",
  packageName: "hono-drizzle-just-template",
  serviceName: "hono-drizzle-just",
  repositorySlug: "Lamy210/Hono-Drizzle-Just",
});

const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9._-]+$/;

function normalizeRepositorySlug(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const parts = trimmed.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || !REPOSITORY_PART_PATTERN.test(part))
  ) {
    return undefined;
  }
  return `${parts[0]}/${parts[1]}`;
}

export function parseGitHubRepository(value: string): string | undefined {
  const trimmed = value.trim();
  const direct = normalizeRepositorySlug(trimmed);
  if (direct) {
    return direct;
  }

  const scpLike = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (scpLike?.[1]) {
    return normalizeRepositorySlug(scpLike[1]);
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") {
      return undefined;
    }
    return normalizeRepositorySlug(url.pathname.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
}

function assertDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || /[\r\n]/.test(normalized)) {
    throw new Error("display name must be non-empty and contain no line breaks");
  }
  return normalized;
}

function assertPackageName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 214 ||
    normalized !== normalized.toLowerCase() ||
    !PACKAGE_NAME_PATTERN.test(normalized)
  ) {
    throw new Error("package name must be a lowercase unscoped npm-safe name");
  }
  return normalized;
}

function assertServiceName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 100 ||
    normalized !== normalized.toLowerCase() ||
    !SERVICE_NAME_PATTERN.test(normalized)
  ) {
    throw new Error("service name must be lowercase ASCII alphanumeric plus hyphens");
  }
  return normalized;
}

function derivePackageName(repositoryName: string): string {
  return assertPackageName(repositoryName.toLowerCase());
}

function deriveServiceName(repositoryName: string): string {
  const kebab = repositoryName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
  return assertServiceName(kebab);
}

export function resolveTemplateIdentity(input: IdentityInput): TemplateIdentity {
  if (!input.repository) {
    throw new Error("repository identity is required");
  }
  const repositorySlug = parseGitHubRepository(input.repository);
  if (!repositorySlug) {
    throw new Error("repository must be a GitHub owner/repo slug or GitHub URL");
  }

  const repositoryName = repositorySlug.split("/")[1];
  if (!repositoryName) {
    throw new Error("repository name is required");
  }

  return {
    displayName: assertDisplayName(input.displayName ?? repositoryName),
    packageName: assertPackageName(input.packageName ?? derivePackageName(repositoryName)),
    serviceName: assertServiceName(input.serviceName ?? deriveServiceName(repositoryName)),
    repositorySlug,
  };
}
