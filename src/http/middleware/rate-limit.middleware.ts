import { createMiddleware } from "hono/factory";
import type { RateLimiter } from "../../core/rate-limit/rate-limiter";
import { AppError } from "../../core/errors/app-error";
import type { AppEnv } from "../env";
import { createAppErrorResponse } from "../error-response";

const GLOBAL_HTTP_RATE_LIMIT_SCOPE = "http.global";
const BYPASS_PATHS = new Set(["/health", "/health/live", "/health/ready"]);

function retryAfterSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("Rate limiter returned an invalid retryAfterSeconds value");
  }
  return Math.ceil(value);
}

export function createRateLimitMiddleware(rateLimiter: RateLimiter) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (BYPASS_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const identity = c.get("requestContext").clientAddress;
    if (identity === undefined) {
      await next();
      return;
    }

    const decision = await rateLimiter.consume({
      scope: GLOBAL_HTTP_RATE_LIMIT_SCOPE,
      identity,
    });
    if (decision.allowed) {
      await next();
      return;
    }

    c.header("Retry-After", String(retryAfterSeconds(decision.retryAfterSeconds)));
    return createAppErrorResponse(
      c,
      new AppError("RATE_LIMITED", "Too many requests", 429),
    );
  });
}
