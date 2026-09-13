import { z } from "zod";
import type { LogLevel } from "../core/logging/logger";

function integerEnv(defaultValue: number, min: number, max: number) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === "") {
        return defaultValue;
      }
      return typeof value === "number" ? value : Number(value);
    },
    z.number().finite().int().min(min).max(max),
  );
}

function isPostgresUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

const RawConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_NAME: z.string().trim().min(1).max(100).default("hono-drizzle-just"),
  PORT: integerEnv(3000, 1, 65_535),
  DATABASE_URL: z.string().refine(isPostgresUrl, {
    message: "must be a valid postgres: or postgresql: URL",
  }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HTTP_DEFAULT_TIMEOUT_MS: integerEnv(10_000, 1, 120_000),
  HTTP_DEFAULT_ATTEMPT_TIMEOUT_MS: integerEnv(3_000, 1, 120_000),
  DATABASE_POOL_MAX: integerEnv(10, 1, 100),
  DATABASE_CONNECTION_TIMEOUT_MS: integerEnv(5_000, 100, 120_000),
  HEALTH_CHECK_TIMEOUT_MS: integerEnv(1_500, 50, 30_000),
  SHUTDOWN_TIMEOUT_MS: integerEnv(10_000, 100, 120_000),
});

export interface AppConfig {
  readonly environment: "development" | "test" | "production";
  readonly serviceName: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  readonly httpDefaultTimeoutMs: number;
  readonly httpDefaultAttemptTimeoutMs: number;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export const AppConfigSchema = RawConfigSchema.transform(
  (raw): AppConfig => ({
    environment: raw.NODE_ENV,
    serviceName: raw.SERVICE_NAME,
    port: raw.PORT,
    databaseUrl: raw.DATABASE_URL,
    logLevel: raw.LOG_LEVEL,
    httpDefaultTimeoutMs: raw.HTTP_DEFAULT_TIMEOUT_MS,
    httpDefaultAttemptTimeoutMs: raw.HTTP_DEFAULT_ATTEMPT_TIMEOUT_MS,
    databasePoolMax: raw.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: raw.DATABASE_CONNECTION_TIMEOUT_MS,
    healthCheckTimeoutMs: raw.HEALTH_CHECK_TIMEOUT_MS,
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
  }),
);
