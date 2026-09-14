import { expect, test } from "bun:test";
import { createProductionContainer } from "../../../../src/app/composition/container";
import { loadConfig } from "../../../../src/config/load-config";
import { NoopMeter } from "../../../../src/core/observability/noop-meter";
import { NoopTracer } from "../../../../src/core/observability/noop-tracer";

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
