import type { ErrorHandler } from "hono";
import { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";
import { createAppErrorResponse } from "./error-response";
import { httpRouteLabel } from "./route-label";

function errorType(error: Error): string {
  return error.name || "Error";
}

function errorCauseType(error: Error): string | undefined {
  if (!(error.cause instanceof Error)) {
    return undefined;
  }
  return errorType(error.cause);
}

export function createErrorHandler(): ErrorHandler<AppEnv> {
  return (error, c) => {
    const logger = c.get("logger");
    const appError =
      error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Internal server error", 500, undefined, {
            cause: error,
          });

    const context = {
      errorCode: appError.code,
      statusCode: appError.status,
      method: c.req.method,
      route: httpRouteLabel(c),
    } as const;

    if (appError.status >= 500) {
      const causeType = errorCauseType(error);
      logger.error("http.request.error", {
        ...context,
        errorType: errorType(error),
        ...(causeType === undefined ? {} : { causeType }),
      });
    } else {
      logger.warn("http.request.rejected", context);
    }

    return createAppErrorResponse(c, appError);
  };
}
