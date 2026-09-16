export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "REQUEST_BODY_TOO_LARGE"
  | "INVALID_HTTP_PATH"
  | "UPSTREAM_REQUEST_FAILED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_RESPONSE_INVALID"
  | "INTERNAL_ERROR";

export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 504;

export class AppError extends Error {
  readonly name = "AppError";

  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly status: AppErrorStatus,
    readonly details: unknown | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
