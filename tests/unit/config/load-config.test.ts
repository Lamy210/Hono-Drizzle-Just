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
      databasePoolMax: 20,
      databaseConnectionTimeoutMs: 5_000,
      healthCheckTimeoutMs: 1_500,
      shutdownTimeoutMs: 10_000,
    });
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
