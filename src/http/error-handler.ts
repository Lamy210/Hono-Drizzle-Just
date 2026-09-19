import type { ErrorHandler } from "hono";
import { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";
import { createAppErrorResponse } from "./error-response";

export function createErrorHandler(): ErrorHandler<AppEnv> {
  return (error, c) => {
    const logger = c.get("logger");
    const appError =
      error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Internal server error", 500, undefined, { cause: error });

    logger.error("http.request.error", {
      error,
      errorCode: appError.code,
      statusCode: appError.status,
      method: c.req.method,
      path: c.req.path,
    });

    return createAppErrorResponse(c, appError);
  };
}
