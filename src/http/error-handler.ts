import type { ErrorHandler } from "hono";
import { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";
import { createAppErrorResponse } from "./error-response";

function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  if (error === null) {
    return "null";
  }
  return typeof error;
}

function errorCauseType(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined) {
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
      path: c.req.path,
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
