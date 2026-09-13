import type { ErrorHandler } from "hono";
import { ErrorResponseSchema } from "../contracts/common/errors";
import { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";

export function createErrorHandler(): ErrorHandler<AppEnv> {
  return (error, c) => {
    const context = c.get("requestContext");
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

    const body = ErrorResponseSchema.parse({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
      requestId: context.requestId,
      traceId: context.trace.traceId,
    });

    return c.json(body, appError.status);
  };
}
