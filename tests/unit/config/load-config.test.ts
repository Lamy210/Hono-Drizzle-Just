import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../../../src/config/load-config";

const required = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/app",
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
      databasePoolMax: 20,
      databaseConnectionTimeoutMs: 5_000,
      healthCheckTimeoutMs: 1_500,
      shutdownTimeoutMs: 10_000,
      otelEnabled: false,
      otelExporterOtlpEndpoint: "http://localhost:4318",
      otelMetricExportIntervalMs: 60_000,
    });
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
