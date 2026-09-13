import type { LogLevel } from "../../core/logging/logger";
import { createDatabase } from "../../infrastructure/database/database";
import { JsonConsoleLogger } from "../../infrastructure/logging/json-console-logger";
import { CreateUserService } from "../../modules/users/application/create-user.service";
import { GetUserService } from "../../modules/users/application/get-user.service";
import { DrizzleUserRepository } from "../../modules/users/infrastructure/drizzle-user.repository";
import type { AppDependencies } from "../app";

function logLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

export function createProductionContainer(): {
  dependencies: AppDependencies;
  close: () => Promise<void>;
} {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const logger = new JsonConsoleLogger(
    {
      service: "hono-drizzle-just",
      environment: process.env.NODE_ENV ?? "development",
    },
    undefined,
    logLevel(process.env.LOG_LEVEL),
  );
  const database = createDatabase(databaseUrl);
  const userRepository = new DrizzleUserRepository(database.db);

  return {
    dependencies: {
      logger,
      createUserService: new CreateUserService(userRepository, logger),
      getUserService: new GetUserService(userRepository),
    },
    close: database.close,
  };
}
