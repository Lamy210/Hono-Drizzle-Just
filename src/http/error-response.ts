import type { Context } from "hono";
import { ErrorResponseSchema } from "../contracts/common/errors";
import type { AppError } from "../core/errors/app-error";
import type { AppEnv } from "./env";

export function createAppErrorResponse(c: Context<AppEnv>, appError: AppError) {
  const context = c.get("requestContext");
  c.header("Cache-Control", "no-store");
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
}
