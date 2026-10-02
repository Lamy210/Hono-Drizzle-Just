import type { ErrorHandler } from "hono";
import { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";
import { createAppErrorResponse } from "./error-response";
import { httpRouteLabel } from "./route-label";

function errorType(error: Error): string {
  try {
    const name = Reflect.get(error, "name");
    return typeof name === "string" && name.length > 0 ? name : "Error";
  } catch {
    return "Error";
  }
}

function errorCauseType(error: Error): string | undefined {
  let cause: unknown;
  try {
    cause = Reflect.get(error, "cause");
  } catch {
    return undefined;
  }

  try {
    return cause instanceof Error ? errorType(cause) : undefined;
  } catch {
    return undefined;
  }
}

export function createErrorHandler(): ErrorHandler<AppEnv> {
  return (error, c) => {
    const logger = c.get("logger");
    const appError =
      error instanceof AppError
        ? error
        : new AppError("INTERNAL_ERROR", "Internal server error", 500);

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
