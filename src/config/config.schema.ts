import { z } from "zod";
import { hasControlCharacters, isValidTenantId } from "../core/auth/tenant-authorization";
import type { LogLevel } from "../core/logging/logger";
import { parseIpCidr } from "../core/network/ip-cidr";

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

const scopePattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;

function parseStaticScopes(value: string): readonly string[] {
  return [...new Set(value.split(" ").filter((scope) => scope.length > 0))];
}

function parseTrustedProxyCidrs(value: string): readonly string[] {
  if (value === "") {
    return [];
  }
  return [...new Set(value.split(",").map((cidr) => cidr.trim()))];
}

function isValidTrustedProxyCidrs(value: string): boolean {
  const cidrs = parseTrustedProxyCidrs(value);
  return (
    cidrs.length <= 32 &&
    cidrs.every((cidr) => cidr.length > 0 && parseIpCidr(cidr) !== undefined)
  );
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
    HTTP_TRUSTED_PROXY_CIDRS: z.string().max(4_096).default("").refine(isValidTrustedProxyCidrs, {
      message: "must contain at most 32 comma-delimited IPv4/IPv6 CIDR ranges",
    }),
    DATABASE_POOL_MAX: integerEnv(10, 1, 100),
    DATABASE_CONNECTION_TIMEOUT_MS: integerEnv(5_000, 100, 120_000),
    HEALTH_CHECK_TIMEOUT_MS: integerEnv(1_500, 50, 30_000),
    SHUTDOWN_TIMEOUT_MS: integerEnv(10_000, 100, 120_000),
    OTEL_ENABLED: booleanEnv(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318").refine(isOtlpHttpEndpoint, {
      message: "must be an HTTP(S) URL without credentials, query, or fragment",
    }),
    OTEL_METRIC_EXPORT_INTERVAL_MS: integerEnv(60_000, 1_000, 300_000),
    AUTH_DEV_STATIC_ENABLED: booleanEnv(false),
    AUTH_DEV_STATIC_BEARER_TOKEN: z.string().default(""),
    AUTH_DEV_STATIC_SUBJECT: z.string().default(""),
    AUTH_DEV_STATIC_TENANT_ID: z.string().default(""),
    AUTH_DEV_STATIC_SCOPES: z.string().max(2_048, "must be at most 2048 characters").default(""),
  })
  .superRefine((raw, context) => {
    if (raw.HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES <= raw.HTTP_MAX_REQUEST_BODY_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES"],
        message: "must be greater than HTTP_MAX_REQUEST_BODY_BYTES",
      });
    }

    if (!raw.AUTH_DEV_STATIC_ENABLED) {
      return;
    }

    if (raw.NODE_ENV === "production") {
      context.addIssue({
        code: "custom",
        path: ["AUTH_DEV_STATIC_ENABLED"],
        message: "development static authentication cannot be enabled in production",
      });
    }

    const tokenBytes = new TextEncoder().encode(raw.AUTH_DEV_STATIC_BEARER_TOKEN).byteLength;
    if (tokenBytes < 32 || tokenBytes > 512) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_DEV_STATIC_BEARER_TOKEN"],
        message: "must be configured with 32 to 512 bytes when static authentication is enabled",
      });
    }

    const subject = raw.AUTH_DEV_STATIC_SUBJECT;
    if (
      subject.length < 1 ||
      subject.length > 200 ||
      subject !== subject.trim() ||
      hasControlCharacters(subject)
    ) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_DEV_STATIC_SUBJECT"],
        message: "must be a normalized 1 to 200 character subject without control characters",
      });
    }

    if (!isValidTenantId(raw.AUTH_DEV_STATIC_TENANT_ID)) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_DEV_STATIC_TENANT_ID"],
        message: "must be a valid normalized tenant identifier",
      });
    }

    const scopes = parseStaticScopes(raw.AUTH_DEV_STATIC_SCOPES);
    if (scopes.length === 0 || scopes.length > 32 || scopes.some((scope) => !scopePattern.test(scope))) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_DEV_STATIC_SCOPES"],
        message: "must contain 1 to 32 valid space-delimited scopes",
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
  readonly httpTrustedProxyCidrs: readonly string[];
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly otelEnabled: boolean;
  readonly otelExporterOtlpEndpoint: string;
  readonly otelMetricExportIntervalMs: number;
  readonly authDevStaticEnabled: boolean;
  readonly authDevStaticBearerToken: string;
  readonly authDevStaticSubject: string;
  readonly authDevStaticTenantId: string;
  readonly authDevStaticScopes: readonly string[];
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
    httpTrustedProxyCidrs: parseTrustedProxyCidrs(raw.HTTP_TRUSTED_PROXY_CIDRS),
    databasePoolMax: raw.DATABASE_POOL_MAX,
    databaseConnectionTimeoutMs: raw.DATABASE_CONNECTION_TIMEOUT_MS,
    healthCheckTimeoutMs: raw.HEALTH_CHECK_TIMEOUT_MS,
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
    otelEnabled: raw.OTEL_ENABLED,
    otelExporterOtlpEndpoint: normalizeOtlpHttpEndpoint(raw.OTEL_EXPORTER_OTLP_ENDPOINT),
    otelMetricExportIntervalMs: raw.OTEL_METRIC_EXPORT_INTERVAL_MS,
    authDevStaticEnabled: raw.AUTH_DEV_STATIC_ENABLED,
    authDevStaticBearerToken: raw.AUTH_DEV_STATIC_BEARER_TOKEN,
    authDevStaticSubject: raw.AUTH_DEV_STATIC_SUBJECT,
    authDevStaticTenantId: raw.AUTH_DEV_STATIC_TENANT_ID,
    authDevStaticScopes: raw.AUTH_DEV_STATIC_ENABLED ? parseStaticScopes(raw.AUTH_DEV_STATIC_SCOPES) : [],
  }),
);
