import type { RateLimitRequest } from "../../core/rate-limit/rate-limiter";

export function snapshotRateLimitRequest(request: unknown): RateLimitRequest {
  if (typeof request !== "object" || request === null) {
    throw new TypeError("Rate limit request must be a non-array object");
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(request);
  } catch {
    throw new TypeError("Rate limit request could not be read");
  }
  if (isArray) {
    throw new TypeError("Rate limit request must be a non-array object");
  }

  let scope: unknown;
  let identity: unknown;
  try {
    scope = Reflect.get(request, "scope");
    identity = Reflect.get(request, "identity");
  } catch {
    throw new TypeError("Rate limit request could not be read");
  }

  if (typeof scope !== "string") {
    throw new TypeError("Rate limit scope must be a normalized 1 to 100 character identifier");
  }
  if (typeof identity !== "string") {
    throw new TypeError("Rate limit identity is invalid");
  }

  return { scope, identity };
}
