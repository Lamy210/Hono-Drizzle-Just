import type { AppConfig } from "../../config/load-config";
import { ReadinessChecker } from "../../core/health/readiness-checker";
import { ApplicationLifecycle } from "../../core/lifecycle/application-lifecycle";
import { createDatabase } from "../../infrastructure/database/database";
import { DatabaseObserver } from "../../infrastructure/database/database-observer";
import { DatabaseHealthCheck } from "../../infrastructure/health/database-health-check";
import { JsonConsoleLogger } from "../../infrastructure/logging/json-console-logger";
import { createTelemetry } from "../../infrastructure/observability/telemetry";
import { CreateUserService } from "../../modules/users/application/create-user.service";
import { GetUserService } from "../../modules/users/application/get-user.service";
import type { AppDependencies } from "../app";
import { createDatabaseAccess } from "./database-access";

export function createProductionContainer(config: AppConfig): {
  dependencies: AppDependencies;
  lifecycle: ApplicationLifecycle;
  close: () => Promise<void>;
} {
  const logger = new JsonConsoleLogger(
    {
      service: config.serviceName,
      environment: config.environment,
    },
    undefined,
    config.logLevel,
  );
  const telemetry = createTelemetry({
    enabled: config.otelEnabled,
    serviceName: config.serviceName,
    environment: config.environment,
    endpoint: config.otelExporterOtlpEndpoint,
    metricExportIntervalMs: config.otelMetricExportIntervalMs,
  });
  const databaseObserver = new DatabaseObserver({
    tracer: telemetry.tracer,
    meter: telemetry.meter,
  });
  const database = createDatabase({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  const lifecycle = new ApplicationLifecycle();
  // Resources close in reverse registration order: database first, telemetry last.
  lifecycle.register("telemetry", telemetry.shutdown);
  lifecycle.register("database", database.close);

  const { userRepository, userTransactions } = createDatabaseAccess(database.db, databaseObserver);
  const readinessChecker = new ReadinessChecker([
    new DatabaseHealthCheck(database.pool, config.healthCheckTimeoutMs),
  ]);

  return {
    dependencies: {
      logger,
      readinessChecker,
      createUserService: new CreateUserService(userTransactions, logger),
      getUserService: new GetUserService(userRepository),
      tracer: telemetry.tracer,
      meter: telemetry.meter,
    },
    lifecycle,
    close: () => lifecycle.close(),
  };
}
