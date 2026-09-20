import type { AppConfig } from "../../config/load-config";
import { ReadinessChecker } from "../../core/health/readiness-checker";
import { ApplicationLifecycle } from "../../core/lifecycle/application-lifecycle";
import { StaticBearerPrincipalResolver } from "../../infrastructure/auth/static-bearer-principal-resolver";
import { HTTP_RATE_LIMIT_SCOPES } from "../../http/rate-limit-policy";
import { Sha256StringDigester } from "../../infrastructure/crypto/sha256-string-digester";
import { createDatabase } from "../../infrastructure/database/database";
import { DatabaseObserver } from "../../infrastructure/database/database-observer";
import { DatabasePoolObserver } from "../../infrastructure/database/database-pool-observer";
import { DatabaseHealthCheck } from "../../infrastructure/health/database-health-check";
import { JsonConsoleLogger } from "../../infrastructure/logging/json-console-logger";
import { PostgresFixedWindowRateLimiter } from "../../infrastructure/rate-limit/postgres-fixed-window-rate-limiter";
import { PostgresGcraRateLimiter } from "../../infrastructure/rate-limit/postgres-gcra-rate-limiter";
import { RateLimitObserver } from "../../infrastructure/rate-limit/rate-limit-observer";
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
  const databasePoolObserver = new DatabasePoolObserver({
    meter: telemetry.meter,
    pool: database.pool,
    poolName: "primary",
    maxConnections: config.databasePoolMax,
  });
  const stopDatabasePoolObservation = databasePoolObserver.observe();

  const lifecycle = new ApplicationLifecycle();
  lifecycle.register("telemetry", telemetry.shutdown);
  lifecycle.register("database-pool-observability", stopDatabasePoolObservation);
  lifecycle.register("database", database.close);

  const { userRepository, userTransactions } = createDatabaseAccess(database.db, databaseObserver);
  const readinessChecker = new ReadinessChecker([
    new DatabaseHealthCheck(database.pool, config.healthCheckTimeoutMs),
  ]);
  const principalResolver = config.authDevStaticEnabled
    ? new StaticBearerPrincipalResolver({
        token: config.authDevStaticBearerToken,
        subject: config.authDevStaticSubject,
        tenantId: config.authDevStaticTenantId,
        scopes: config.authDevStaticScopes,
      })
    : undefined;
  const digester = new Sha256StringDigester();
  const rateLimitObserver = new RateLimitObserver({ meter: telemetry.meter });
  const rateLimitOptions = {
    limit: config.httpRateLimitRequests,
    windowSeconds: config.httpRateLimitWindowSeconds,
    policies: {
      [HTTP_RATE_LIMIT_SCOPES.usersWrite]: {
        limit: config.httpRateLimitUsersWriteRequests,
        windowSeconds: config.httpRateLimitUsersWriteWindowSeconds,
      },
      [HTTP_RATE_LIMIT_SCOPES.usersRead]: {
        limit: config.httpRateLimitUsersReadRequests,
        windowSeconds: config.httpRateLimitUsersReadWindowSeconds,
      },
    },
  };
  const rateLimiter = !config.httpRateLimitEnabled
    ? undefined
    : config.httpRateLimitAlgorithm === "gcra"
      ? new PostgresGcraRateLimiter(
          database.db,
          digester,
          rateLimitOptions,
          databaseObserver,
          rateLimitObserver,
        )
      : new PostgresFixedWindowRateLimiter(
          database.db,
          digester,
          rateLimitOptions,
          databaseObserver,
          rateLimitObserver,
        );

  return {
    dependencies: {
      logger,
      readinessChecker,
      createUserService: new CreateUserService(userTransactions, logger, digester),
      getUserService: new GetUserService(userRepository),
      ...(principalResolver === undefined ? {} : { principalResolver }),
      ...(rateLimiter === undefined ? {} : { rateLimiter }),
      tracer: telemetry.tracer,
      meter: telemetry.meter,
    },
    lifecycle,
    close: () => lifecycle.close(),
  };
}
