import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../../../src/config/load-config";

const required = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/app",
};

const staticAuth = {
  AUTH_DEV_STATIC_ENABLED: "true",
  AUTH_DEV_STATIC_BEARER_TOKEN: "0123456789abcdef0123456789abcdef",
  AUTH_DEV_STATIC_SUBJECT: "test-user",
  AUTH_DEV_STATIC_TENANT_ID: "tenant-a",
  AUTH_DEV_STATIC_SCOPES: "users:read users:write users:read",
};

describe("loadConfig", () => {
  test("applies safe defaults and coerces numeric values", () => {
    const config = loadConfig({ ...required, PORT: "8080", DATABASE_POOL_MAX: "20" });

    expect(config).toMatchObject({
      environment: "development",
      serviceName: "hono-drizzle-just",
      port: 8080,
      logLevel: "info",
      httpDefaultTimeoutMs: 10_000,
      httpDefaultAttemptTimeoutMs: 3_000,
      httpMaxRequestBodyBytes: 1_048_576,
      httpTransportMaxRequestBodyBytes: 2_097_152,
      httpTrustedProxyCidrs: [],
      httpRateLimitEnabled: false,
      httpRateLimitAlgorithm: "fixed_window",
      httpRateLimitRequests: 120,
      httpRateLimitWindowSeconds: 60,
      httpRateLimitUsersWriteRequests: 30,
      httpRateLimitUsersWriteWindowSeconds: 60,
      httpRateLimitUsersReadRequests: 120,
      httpRateLimitUsersReadWindowSeconds: 60,
      databasePoolMax: 20,
      databaseConnectionTimeoutMs: 5_000,
      databaseStatementTimeoutMs: 15_000,
      databaseLockTimeoutMs: 2_000,
      databaseIdleInTransactionSessionTimeoutMs: 30_000,
      databaseTransactionRetryMaxAttempts: 3,
      databaseTransactionRetryBaseDelayMs: 10,
      databaseTransactionRetryMaxDelayMs: 100,
      healthCheckTimeoutMs: 1_500,
      shutdownTimeoutMs: 10_000,
      otelEnabled: false,
      otelExporterOtlpEndpoint: "http://localhost:4318",
      otelMetricExportIntervalMs: 60_000,
      authDevStaticEnabled: false,
      authDevStaticScopes: [],
    });
  });

  test("parses enabled static bearer configuration and deduplicates scopes", () => {
    const config = loadConfig({ ...required, ...staticAuth, NODE_ENV: "test" });

    expect(config).toMatchObject({
      authDevStaticEnabled: true,
      authDevStaticBearerToken: staticAuth.AUTH_DEV_STATIC_BEARER_TOKEN,
      authDevStaticSubject: "test-user",
      authDevStaticTenantId: "tenant-a",
      authDevStaticScopes: ["users:read", "users:write"],
    });
  });

  test("rejects static bearer authentication in production", () => {
    expect(() => loadConfig({ ...required, ...staticAuth, NODE_ENV: "production" })).toThrow(
      ConfigurationError,
    );
  });

  test("requires complete valid static auth fields only when enabled", () => {
    for (const missing of [
      "AUTH_DEV_STATIC_BEARER_TOKEN",
      "AUTH_DEV_STATIC_SUBJECT",
      "AUTH_DEV_STATIC_TENANT_ID",
      "AUTH_DEV_STATIC_SCOPES",
    ] as const) {
      const env: Record<string, string | undefined> = { ...required, ...staticAuth, NODE_ENV: "test" };
      delete env[missing];
      expect(() => loadConfig(env)).toThrow(ConfigurationError);
    }

    expect(() =>
      loadConfig({ ...required, ...staticAuth, NODE_ENV: "test", AUTH_DEV_STATIC_BEARER_TOKEN: "short" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...required, ...staticAuth, NODE_ENV: "test", AUTH_DEV_STATIC_TENANT_ID: " __bad " }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...required, ...staticAuth, NODE_ENV: "test", AUTH_DEV_STATIC_TENANT_ID: "__legacy__:1" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...required, ...staticAuth, NODE_ENV: "test", AUTH_DEV_STATIC_SCOPES: "users:read bad/scope" }),
    ).toThrow(ConfigurationError);
  });

  test("does not include static bearer token contents in configuration errors", () => {
    const secret = "super-secret-static-bearer-token-that-must-not-leak";
    try {
      loadConfig({
        ...required,
        ...staticAuth,
        NODE_ENV: "production",
        AUTH_DEV_STATIC_BEARER_TOKEN: secret,
      });
      throw new Error("expected loadConfig to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  test("rejects a transport body cap that does not exceed the application body limit", () => {
    expect(() =>
      loadConfig({
        ...required,
        HTTP_MAX_REQUEST_BODY_BYTES: "4096",
        HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES: "4096",
      }),
    ).toThrow(ConfigurationError);
  });

  test("parses and deduplicates trusted proxy CIDRs", () => {
    const config = loadConfig({
      ...required,
      HTTP_TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8::/32,10.0.0.0/8",
    });

    expect(config.httpTrustedProxyCidrs).toEqual(["10.0.0.0/8", "2001:db8::/32"]);
  });

  test("rejects malformed trusted proxy CIDRs", () => {
    for (const value of [
      "10.0.0.0",
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.0/8,,192.168.0.0/16",
      "not-an-ip/24",
    ]) {
      expect(() => loadConfig({ ...required, HTTP_TRUSTED_PROXY_CIDRS: value })).toThrow(
        ConfigurationError,
      );
    }
  });

  test("parses explicit rate limit settings", () => {
    const config = loadConfig({
      ...required,
      HTTP_RATE_LIMIT_ENABLED: "true",
      HTTP_RATE_LIMIT_ALGORITHM: "gcra",
      HTTP_RATE_LIMIT_REQUESTS: "250",
      HTTP_RATE_LIMIT_WINDOW_SECONDS: "30",
      HTTP_RATE_LIMIT_USERS_WRITE_REQUESTS: "20",
      HTTP_RATE_LIMIT_USERS_WRITE_WINDOW_SECONDS: "15",
      HTTP_RATE_LIMIT_USERS_READ_REQUESTS: "400",
      HTTP_RATE_LIMIT_USERS_READ_WINDOW_SECONDS: "45",
    });

    expect(config).toMatchObject({
      httpRateLimitEnabled: true,
      httpRateLimitAlgorithm: "gcra",
      httpRateLimitRequests: 250,
      httpRateLimitWindowSeconds: 30,
      httpRateLimitUsersWriteRequests: 20,
      httpRateLimitUsersWriteWindowSeconds: 15,
      httpRateLimitUsersReadRequests: 400,
      httpRateLimitUsersReadWindowSeconds: 45,
    });
  });

  test("rejects invalid rate limit settings", () => {
    expect(() => loadConfig({ ...required, HTTP_RATE_LIMIT_ENABLED: "yes" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...required, HTTP_RATE_LIMIT_ALGORITHM: "sliding_window" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...required, HTTP_RATE_LIMIT_REQUESTS: "0" })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ ...required, HTTP_RATE_LIMIT_WINDOW_SECONDS: "86401" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({ ...required, HTTP_RATE_LIMIT_USERS_WRITE_REQUESTS: "0" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...required, HTTP_RATE_LIMIT_USERS_READ_WINDOW_SECONDS: "86401" }),
    ).toThrow(ConfigurationError);
  });

  test("parses database execution timeout settings including explicit disable", () => {
    const config = loadConfig({
      ...required,
      DATABASE_CONNECTION_TIMEOUT_MS: "7000",
      DATABASE_STATEMENT_TIMEOUT_MS: "2500",
      DATABASE_LOCK_TIMEOUT_MS: "500",
      DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "0",
    });

    expect(config).toMatchObject({
      databaseConnectionTimeoutMs: 7_000,
      databaseStatementTimeoutMs: 2_500,
      databaseLockTimeoutMs: 500,
      databaseIdleInTransactionSessionTimeoutMs: 0,
    });
  });

  test("rejects database execution timeout settings outside bounded ranges", () => {
    expect(() => loadConfig({ ...required, DATABASE_STATEMENT_TIMEOUT_MS: "-1" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({
        ...required,
        DATABASE_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: "3600001",
      }),
    ).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...required, DATABASE_LOCK_TIMEOUT_MS: "-1" })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      loadConfig({
        ...required,
        DATABASE_STATEMENT_TIMEOUT_MS: "2000",
        DATABASE_LOCK_TIMEOUT_MS: "2000",
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({
        ...required,
        DATABASE_STATEMENT_TIMEOUT_MS: "2000",
        DATABASE_LOCK_TIMEOUT_MS: "2500",
      }),
    ).toThrow(ConfigurationError);
  });

  test("parses and validates transaction retry settings", () => {
    const config = loadConfig({
      ...required,
      DATABASE_TRANSACTION_RETRY_MAX_ATTEMPTS: "5",
      DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS: "25",
      DATABASE_TRANSACTION_RETRY_MAX_DELAY_MS: "250",
    });

    expect(config).toMatchObject({
      databaseTransactionRetryMaxAttempts: 5,
      databaseTransactionRetryBaseDelayMs: 25,
      databaseTransactionRetryMaxDelayMs: 250,
    });

    expect(() =>
      loadConfig({ ...required, DATABASE_TRANSACTION_RETRY_MAX_ATTEMPTS: "11" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({
        ...required,
        DATABASE_TRANSACTION_RETRY_BASE_DELAY_MS: "200",
        DATABASE_TRANSACTION_RETRY_MAX_DELAY_MS: "100",
      }),
    ).toThrow(ConfigurationError);
  });

  test("parses explicit OpenTelemetry settings", () => {
    const config = loadConfig({
      ...required,
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com/otel/",
      OTEL_METRIC_EXPORT_INTERVAL_MS: "15000",
    });

    expect(config).toMatchObject({
      otelEnabled: true,
      otelExporterOtlpEndpoint: "https://collector.example.com/otel",
      otelMetricExportIntervalMs: 15_000,
    });
  });

  test("rejects malformed OpenTelemetry configuration", () => {
    expect(() => loadConfig({ ...required, OTEL_ENABLED: "yes" })).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({ ...required, OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector.example.com" }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadConfig({
        ...required,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example.com",
      }),
    ).toThrow(ConfigurationError);
  });

  test("rejects ports outside the TCP range", () => {
    expect(() => loadConfig({ ...required, PORT: "70000" })).toThrow(ConfigurationError);
  });

  test("rejects a non-PostgreSQL DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "https://example.com/database" })).toThrow(
      ConfigurationError,
    );
  });

  test("does not include DATABASE_URL contents in configuration errors", () => {
    const secretUrl = "https://user:super-secret@example.com/database";
    try {
      loadConfig({ DATABASE_URL: secretUrl });
      throw new Error("expected loadConfig to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain("super-secret");
      expect(String(error)).not.toContain(secretUrl);
    }
  });
});
