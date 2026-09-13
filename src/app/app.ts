import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "../core/errors/app-error";
import type { Logger } from "../core/logging/logger";
import { createErrorHandler } from "../http/error-handler";
import type { AppEnv } from "../http/env";
import { createRequestContextMiddleware } from "../http/middleware/request-context.middleware";
import { requestLoggerMiddleware } from "../http/middleware/request-logger.middleware";
import type { CreateUserService } from "../modules/users/application/create-user.service";
import type { GetUserService } from "../modules/users/application/get-user.service";
import { registerUserRoutes } from "../modules/users/presentation/user.routes";

export interface AppDependencies {
  readonly logger: Logger;
  readonly createUserService: CreateUserService;
  readonly getUserService: GetUserService;
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  responses: {
    200: {
      description: "Service health",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok") }).openapi("HealthResponse"),
        },
      },
    },
  },
});

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

  app.openapi(healthRoute, (c) => c.json({ status: "ok" }, 200));
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
