import { expect, test } from "bun:test";
import {
  HTTP_RATE_LIMIT_SCOPES,
  resolveHttpRateLimitScope,
} from "../../../src/http/rate-limit-policy";

test("GET and HEAD user reads share the same bounded read quota", () => {
  for (const method of ["GET", "HEAD"]) {
    expect(resolveHttpRateLimitScope({ method, path: "/users" })).toBe(
      HTTP_RATE_LIMIT_SCOPES.usersRead,
    );
    expect(
      resolveHttpRateLimitScope({
        method,
        path: "/users/550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toBe(HTTP_RATE_LIMIT_SCOPES.usersRead);
    expect(resolveHttpRateLimitScope({ method, path: "/users/cursor" })).toBe(
      HTTP_RATE_LIMIT_SCOPES.usersRead,
    );
  }
});

test("user writes remain on the write quota and unrelated HEAD requests stay global", () => {
  expect(resolveHttpRateLimitScope({ method: "POST", path: "/users" })).toBe(
    HTTP_RATE_LIMIT_SCOPES.usersWrite,
  );
  expect(
    resolveHttpRateLimitScope({
      method: "PATCH",
      path: "/users/550e8400-e29b-41d4-a716-446655440000",
    }),
  ).toBe(HTTP_RATE_LIMIT_SCOPES.usersWrite);
  expect(
    resolveHttpRateLimitScope({
      method: "DELETE",
      path: "/users/550e8400-e29b-41d4-a716-446655440000",
    }),
  ).toBe(HTTP_RATE_LIMIT_SCOPES.usersWrite);
  for (const method of ["PATCH", "DELETE"]) {
    expect(resolveHttpRateLimitScope({ method, path: "/users/cursor" })).toBe(
      HTTP_RATE_LIMIT_SCOPES.global,
    );
  }
  expect(resolveHttpRateLimitScope({ method: "POST", path: "/users/cursor" })).toBe(
    HTTP_RATE_LIMIT_SCOPES.global,
  );
  for (const method of ["PATCH", "DELETE"]) {
    expect(resolveHttpRateLimitScope({ method, path: "/users/cursor" })).toBe(
      HTTP_RATE_LIMIT_SCOPES.global,
    );
  }
  expect(resolveHttpRateLimitScope({ method: "POST", path: "/users/cursor" })).toBe(
    HTTP_RATE_LIMIT_SCOPES.global,
  );
  expect(resolveHttpRateLimitScope({ method: "HEAD", path: "/openapi.json" })).toBe(
    HTTP_RATE_LIMIT_SCOPES.global,
  );
});

test("health probes continue to bypass rate limiting for HEAD as well as GET", () => {
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/health", "/health/live", "/health/ready"]) {
      expect(resolveHttpRateLimitScope({ method, path })).toBeUndefined();
    }
  }
});
