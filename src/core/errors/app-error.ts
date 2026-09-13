export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_HTTP_PATH"
  | "UPSTREAM_REQUEST_FAILED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_RESPONSE_INVALID"
  | "INTERNAL_ERROR";

export type AppErrorStatus = 400 | 404 | 409 | 500 | 502 | 504;

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
