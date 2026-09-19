import { OpenAPIHono } from "@hono/zod-openapi";
import type { PrincipalResolver } from "../core/auth/principal-resolver";
import { AppError } from "../core/errors/app-error";
import type { ReadinessChecker } from "../core/health/readiness-checker";
import type { Logger } from "../core/logging/logger";
import type { Meter } from "../core/observability/meter";
import type { Tracer } from "../core/observability/tracer";
import { createErrorHandler } from "../http/error-handler";
import type { AppEnv } from "../http/env";
import { registerHealthRoutes } from "../http/health/health.routes";
import { registerRoutingErrorHandlers } from "../http/routing-errors";
import { createRequestBodyLimitMiddleware } from "../http/middleware/request-body-limit.middleware";
import { createRequestContextMiddleware } from "../http/middleware/request-context.middleware";
import { createApiSecurityHeadersMiddleware } from "../http/middleware/security-headers.middleware";
import { requestLoggerMiddleware } from "../http/middleware/request-logger.middleware";
import type { CreateUserService } from "../modules/users/application/create-user.service";
import type { GetUserService } from "../modules/users/application/get-user.service";
import { registerUserRoutes } from "../modules/users/presentation/user.routes";

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

export interface AppDependencies {
  readonly logger: Logger;
  readonly readinessChecker: ReadinessChecker;
  readonly createUserService: CreateUserService;
  readonly getUserService: GetUserService;
  readonly principalResolver?: PrincipalResolver;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
}

export interface AppOptions {
  readonly maxRequestBodyBytes?: number;
}

export function createApp(dependencies: AppDependencies, options: AppOptions = {}) {
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

  app.use("*", createApiSecurityHeadersMiddleware());
  app.use(
    "*",
    createRequestContextMiddleware(
      dependencies.logger,
      dependencies.principalResolver,
      dependencies.tracer && dependencies.meter
        ? { tracer: dependencies.tracer, meter: dependencies.meter }
        : undefined,
    ),
  );
  app.use("*", requestLoggerMiddleware);
  registerRoutingErrorHandlers(app);
  app.use(
    "*",
    createRequestBodyLimitMiddleware(options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES),
  );
  app.onError(createErrorHandler());

  registerHealthRoutes(app, dependencies.readinessChecker);
  registerUserRoutes(app, dependencies);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Hono Drizzle Just API",
      version: "0.1.0",
      description: "Bun + Hono + Drizzle API template with contracts, tracing, logging, and test boundaries.",
    },
  });

  return app;
}
