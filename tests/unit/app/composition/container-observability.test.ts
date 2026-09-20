import { expect, test } from "bun:test";
import { createProductionContainer } from "../../../../src/app/composition/container";
import { loadConfig } from "../../../../src/config/load-config";
import { NoopMeter } from "../../../../src/core/observability/noop-meter";
import { NoopTracer } from "../../../../src/core/observability/noop-tracer";
import { PostgresFixedWindowRateLimiter } from "../../../../src/infrastructure/rate-limit/postgres-fixed-window-rate-limiter";
import { PostgresGcraRateLimiter } from "../../../../src/infrastructure/rate-limit/postgres-gcra-rate-limiter";

test("production composition uses Noop observability when telemetry is disabled", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app",
    NODE_ENV: "test",
    OTEL_ENABLED: "false",
  });
  const container = createProductionContainer(config);

  expect(container.dependencies.tracer).toBeInstanceOf(NoopTracer);
  expect(container.dependencies.meter).toBeInstanceOf(NoopMeter);

  await container.close();
});


test("production composition installs the PostgreSQL limiter only when enabled", async () => {
  const disabled = createProductionContainer(
    loadConfig({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app",
      NODE_ENV: "test",
      HTTP_RATE_LIMIT_ENABLED: "false",
    }),
  );
  expect(disabled.dependencies.rateLimiter).toBeUndefined();
  await disabled.close();

  const enabled = createProductionContainer(
    loadConfig({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app",
      NODE_ENV: "test",
      HTTP_RATE_LIMIT_ENABLED: "true",
      HTTP_RATE_LIMIT_REQUESTS: "25",
      HTTP_RATE_LIMIT_WINDOW_SECONDS: "10",
    }),
  );
  expect(enabled.dependencies.rateLimiter).toBeInstanceOf(PostgresFixedWindowRateLimiter);
  await enabled.close();

  const gcra = createProductionContainer(
    loadConfig({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/app",
      NODE_ENV: "test",
      HTTP_RATE_LIMIT_ENABLED: "true",
      HTTP_RATE_LIMIT_ALGORITHM: "gcra",
      HTTP_RATE_LIMIT_REQUESTS: "25",
      HTTP_RATE_LIMIT_WINDOW_SECONDS: "10",
    }),
  );
  expect(gcra.dependencies.rateLimiter).toBeInstanceOf(PostgresGcraRateLimiter);
  await gcra.close();
});
