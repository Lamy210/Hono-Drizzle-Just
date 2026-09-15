import { bodyLimit } from "hono/body-limit";
import { AppError } from "../../core/errors/app-error";

export function createRequestBodyLimitMiddleware(maxSize: number) {
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
    throw new RangeError("maxRequestBodyBytes must be a positive safe integer");
  }

  return bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError(
        "REQUEST_BODY_TOO_LARGE",
        "Request body is too large",
        413,
        { maxBytes: maxSize },
      );
    },
  });
}
