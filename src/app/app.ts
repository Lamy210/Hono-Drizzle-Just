import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "../core/errors/app-error";
import type { ReadinessChecker } from "../core/health/readiness-checker";
import type { Logger } from "../core/logging/logger";
import { createErrorHandler } from "../http/error-handler";
import type { AppEnv } from "../http/env";
import { registerHealthRoutes } from "../http/health/health.routes";
import { createRequestContextMiddleware } from "../http/middleware/request-context.middleware";
import { requestLoggerMiddleware } from "../http/middleware/request-logger.middleware";
import type { CreateUserService } from "../modules/users/application/create-user.service";
import type { GetUserService } from "../modules/users/application/get-user.service";
import { registerUserRoutes } from "../modules/users/presentation/user.routes";

export interface AppDependencies {
  readonly logger: Logger;
  readonly readinessChecker: ReadinessChecker;
  readonly createUserService: CreateUserService;
  readonly getUserService: GetUserService;
}

export function createApp(dependencies: AppDependencies) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Request validation failed",
          400,
          result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        );
      }
    },
  });

  app.use("*", createRequestContextMiddleware(dependencies.logger));
  app.use("*", requestLoggerMiddleware);
  app.onError(createErrorHandler());

  registerHealthRoutes(app, dependencies.readinessChecker);
  registerUserRoutes(app, dependencies);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Hono Drizzle Just API",
      version: "0.1.0",
      description: "Bun + Hono + Drizzle API template with contracts, tracing, logging, and test boundaries.",
    },
  });

  return app;
}
