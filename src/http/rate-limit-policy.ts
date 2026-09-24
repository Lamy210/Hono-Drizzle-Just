export const HTTP_RATE_LIMIT_SCOPES = {
  global: "http.global",
  usersRead: "http.users.read",
  usersWrite: "http.users.write",
} as const;

const BYPASS_PATHS = new Set(["/health", "/health/live", "/health/ready"]);
const USER_READ_COLLECTION_PATHS = new Set(["/users", "/users/cursor"]);
const USER_READ_COLLECTION_PATHS = new Set(["/users", "/users/cursor"]);

export interface HttpRateLimitPolicyInput {
  readonly method: string;
  readonly path: string;
}

function isSingleUserResourcePath(path: string): boolean {
  if (!path.startsWith("/users/")) {
    return false;
  }
  const resourceId = path.slice("/users/".length);
  return (
    resourceId.length > 0 &&
    !resourceId.includes("/") &&
    resourceId !== "cursor"
  );
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
    (USER_READ_COLLECTION_PATHS.has(input.path) || isSingleUserResourcePath(input.path))
  ) {
    return HTTP_RATE_LIMIT_SCOPES.usersRead;
  }
  return HTTP_RATE_LIMIT_SCOPES.global;
}
