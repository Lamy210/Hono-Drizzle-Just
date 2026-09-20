import { createMiddleware } from "hono/factory";
import type { RateLimiter, RateLimitQuota } from "../../core/rate-limit/rate-limiter";
import { AppError } from "../../core/errors/app-error";
import type { AppEnv } from "../env";
import { createAppErrorResponse } from "../error-response";
import { resolveHttpRateLimitScope } from "../rate-limit-policy";

const POLICY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;

function retryAfterSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("Rate limiter returned an invalid retryAfterSeconds value");
  }
  return Math.ceil(value);
}

function formatRateLimitFields(quota: RateLimitQuota): {
  readonly policy: string;
  readonly service: string;
} {
  if (!POLICY_ID_PATTERN.test(quota.policyId)) {
    throw new TypeError("Rate limiter returned an invalid quota policyId");
  }
  if (!Number.isSafeInteger(quota.limit) || quota.limit < 1) {
    throw new TypeError("Rate limiter returned an invalid quota limit");
  }
  if (
    !Number.isSafeInteger(quota.remaining) ||
    quota.remaining < 0 ||
    quota.remaining > quota.limit
  ) {
    throw new TypeError("Rate limiter returned an invalid quota remaining value");
  }
  if (!Number.isSafeInteger(quota.windowSeconds) || quota.windowSeconds < 1) {
    throw new TypeError("Rate limiter returned an invalid quota windowSeconds value");
  }
  if (!Number.isSafeInteger(quota.resetAfterSeconds) || quota.resetAfterSeconds < 1) {
    throw new TypeError("Rate limiter returned an invalid quota resetAfterSeconds value");
  }

  return {
    policy: `"${quota.policyId}";q=${quota.limit};w=${quota.windowSeconds}`,
    service: `"${quota.policyId}";r=${quota.remaining};t=${quota.resetAfterSeconds}`,
  };
}

function setRateLimitHeaders(
  setHeader: (name: string, value: string) => void,
  quota: RateLimitQuota | undefined,
): void {
  if (quota === undefined) {
    return;
  }

  const fields = formatRateLimitFields(quota);
  setHeader("RateLimit-Policy", fields.policy);
  setHeader("RateLimit", fields.service);
}

export function createRateLimitMiddleware(rateLimiter: RateLimiter) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const scope = resolveHttpRateLimitScope({
      method: c.req.method,
      path: c.req.path,
    });
    if (scope === undefined) {
      await next();
      return;
    }

    const identity = c.get("requestContext").clientAddress;
    if (identity === undefined) {
      await next();
      return;
    }

    const decision = await rateLimiter.consume({
      scope,
      identity,
    });
    if (decision.allowed) {
      await next();
      setRateLimitHeaders((name, value) => c.header(name, value), decision.quota);
      return;
    }

    setRateLimitHeaders((name, value) => c.header(name, value), decision.quota);
    c.header("Retry-After", String(retryAfterSeconds(decision.retryAfterSeconds)));
    return createAppErrorResponse(
      c,
      new AppError("RATE_LIMITED", "Too many requests", 429),
    );
  });
}
