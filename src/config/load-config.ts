import { AppConfigSchema, type AppConfig } from "./config.schema";

export interface ConfigurationIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(issues: readonly ConfigurationIssue[]) {
    super(
      `Invalid configuration: ${issues
        .map((issue) => `${issue.path || "environment"}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = AppConfigSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }

  throw new ConfigurationError(
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

export type { AppConfig } from "./config.schema";
