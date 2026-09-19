import type { OpenAPIHono } from "@hono/zod-openapi";
import { methodNotAllowed } from "hono/method-not-allowed";
import { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";
import { createAppErrorResponse } from "./error-response";

export function registerRoutingErrorHandlers(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "*",
    methodNotAllowed({
      app,
      onMethodNotAllowed: (c, allowedMethods) => {
        c.header("Allow", allowedMethods.join(", "));
        return createAppErrorResponse(
          c,
          new AppError("METHOD_NOT_ALLOWED", "Method not allowed", 405),
        );
      },
    }),
  );

  app.notFound((c) =>
    createAppErrorResponse(c, new AppError("NOT_FOUND", "Resource not found", 404)),
  );
}
