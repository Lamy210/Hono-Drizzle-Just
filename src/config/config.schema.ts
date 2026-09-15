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

function booleanEnv(defaultValue: boolean) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === "") {
        return defaultValue ? "true" : "false";
      }
      return value;
    },
    z.enum(["true", "false"]).transform((value) => value === "true"),
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

function isOtlpHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function normalizeOtlpHttpEndpoint(value: string): string {
  return value.replace(/\/+$/, "");
}

const RawConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    SERVICE_NAME: z.string().trim().min(1).max(100).default("hono-drizzle-just"),
    PORT: integerEnv(3000, 1, 65_535),
    DATABASE_URL: z.string().refine(isPostgresUrl, {
      message: "must be a valid postgres: or postgresql: URL",
    }),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    HTTP_DEFAULT_TIMEOUT_MS: integerEnv(10_000, 1, 120_000),
    HTTP_DEFAULT_ATTEMPT_TIMEOUT_MS: integerEnv(3_000, 1, 120_000),
    HTTP_MAX_REQUEST_BODY_BYTES: integerEnv(1_048_576, 1_024, 64 * 1024 * 1024),
    HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES: integerEnv(2_097_152, 2_048, 128 * 1024 * 1024),
    DATABASE_POOL_MAX: integerEnv(10, 1, 100),
    DATABASE_CONNECTION_TIMEOUT_MS: integerEnv(5_000, 100, 120_000),
    HEALTH_CHECK_TIMEOUT_MS: integerEnv(1_500, 50, 30_000),
    SHUTDOWN_TIMEOUT_MS: integerEnv(10_000, 100, 120_000),
    OTEL_ENABLED: booleanEnv(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318").refine(isOtlpHttpEndpoint, {
      message: "must be an HTTP(S) URL without credentials, query, or fragment",
    }),
    OTEL_METRIC_EXPORT_INTERVAL_MS: integerEnv(60_000, 1_000, 300_000),
  })
  .superRefine((raw, context) => {
    if (raw.HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES <= raw.HTTP_MAX_REQUEST_BODY_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES"],
        message: "must be greater than HTTP_MAX_REQUEST_BODY_BYTES",
      });
    }
  });

export interface AppConfig {
  readonly environment: "development" | "test" | "production";
  readonly serviceName: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  readonly httpDefaultTimeoutMs: number;
  readonly httpDefaultAttemptTimeoutMs: number;
  readonly httpMaxRequestBodyBytes: number;
  readonly httpTransportMaxRequestBodyBytes: number;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly otelEnabled: boolean;
  readonly otelExporterOtlpEndpoint: string;
  readonly otelMetricExportIntervalMs: number;
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
    httpMaxRequestBodyBytes: raw.HTTP_MAX_REQUEST_BODY_BYTES,
    httpTransportMaxRequestBodyBytes: raw.HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES,
    databasePoolMax: raw.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: raw.DATABASE_CONNECTION_TIMEOUT_MS,
    healthCheckTimeoutMs: raw.HEALTH_CHECK_TIMEOUT_MS,
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
    otelEnabled: raw.OTEL_ENABLED,
    otelExporterOtlpEndpoint: normalizeOtlpHttpEndpoint(raw.OTEL_EXPORTER_OTLP_ENDPOINT),
    otelMetricExportIntervalMs: raw.OTEL_METRIC_EXPORT_INTERVAL_MS,
  }),
);
