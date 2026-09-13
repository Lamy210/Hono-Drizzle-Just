import type { AppConfig } from "../../config/load-config";
import { ReadinessChecker } from "../../core/health/readiness-checker";
import { ApplicationLifecycle } from "../../core/lifecycle/application-lifecycle";
import { createDatabase } from "../../infrastructure/database/database";
import { DatabaseHealthCheck } from "../../infrastructure/health/database-health-check";
import { JsonConsoleLogger } from "../../infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../modules/users/application/create-user.service";
import { GetUserService } from "../../modules/users/application/get-user.service";
import { DrizzleUserRepository } from "../../modules/users/infrastructure/drizzle-user.repository";
import type { AppDependencies } from "../app";

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
  const database = createDatabase({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  });
  const lifecycle = new ApplicationLifecycle();
  lifecycle.register("database", database.close);

  const userRepository = new DrizzleUserRepository(database.db);
  const readinessChecker = new ReadinessChecker([
    new DatabaseHealthCheck(database.pool, config.healthCheckTimeoutMs),
  ]);

  return {
    dependencies: {
      logger,
      readinessChecker,
      createUserService: new CreateUserService(userRepository, logger),
      getUserService: new GetUserService(userRepository),
    },
    lifecycle,
    close: () => lifecycle.close(),
  };
}
