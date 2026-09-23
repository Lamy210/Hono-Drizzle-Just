export const HTTP_RATE_LIMIT_SCOPES = {
  global: "http.global",
  usersRead: "http.users.read",
  usersWrite: "http.users.write",
} as const;

const BYPASS_PATHS = new Set(["/health", "/health/live", "/health/ready"]);

export interface HttpRateLimitPolicyInput {
  readonly method: string;
  readonly path: string;
}

function isSingleUserResourcePath(path: string): boolean {
  if (!path.startsWith("/users/")) {
    return false;
  }
  const resourceId = path.slice("/users/".length);
  return resourceId.length > 0 && !resourceId.includes("/");
}

export function resolveHttpRateLimitScope(input: HttpRateLimitPolicyInput): string | undefined {
  if (BYPASS_PATHS.has(input.path)) {
    return undefined;
  }
  if (
    (input.method === "POST" && input.path === "/users") ||
    ((input.method === "PATCH" || input.method === "DELETE") &&
      isSingleUserResourcePath(input.path))
  ) {
    return HTTP_RATE_LIMIT_SCOPES.usersWrite;
  }
  if (
    (input.method === "GET" || input.method === "HEAD") &&
    (input.path === "/users" || isSingleUserResourcePath(input.path))
  ) {
    return HTTP_RATE_LIMIT_SCOPES.usersRead;
  }
  return HTTP_RATE_LIMIT_SCOPES.global;
}
