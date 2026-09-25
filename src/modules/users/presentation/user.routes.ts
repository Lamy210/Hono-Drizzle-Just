import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorResponseSchema } from "../../../contracts/common/errors";
import { IfMatchHeadersSchema, IfNoneMatchHeadersSchema } from "../../../contracts/common/conditional";
import { IdempotencyKeyHeadersSchema } from "../../../contracts/common/idempotency";
import { CursorPaginationQuerySchema, PaginationQuerySchema } from "../../../contracts/common/pagination";
import { CanonicalUuidSchema } from "../../../contracts/common/primitives";
import {
  CreateUserRequestSchema,
  UpdateUserRequestSchema,
  UserCursorListResponseSchema,
  UserListResponseSchema,
  UserPathParamsSchema,
  UserResponseSchema,
} from "../../../contracts/users/user.contracts";
import type { AppEnv } from "../../../http/env";
import type { CreateUserService } from "../application/create-user.service";
import type { DeleteUserService } from "../application/delete-user.service";
import type { GetUserService } from "../application/get-user.service";
import type { ListUsersCursorService } from "../application/list-users-cursor.service";
import type { ListUsersService } from "../application/list-users.service";
import type { UpdateUserService } from "../application/update-user.service";
import { formatUserEntityTag, parseUserIfMatch, userIfNoneMatchMatches } from "./user-etag";
import { decodeUserListCursor, encodeUserListCursor, formatUserListNextLink } from "./user-list-cursor";
import { toUserResponse } from "./user.presenter";

export interface UserRouteDependencies {
  readonly createUserService: CreateUserService;
  readonly deleteUserService: DeleteUserService;
  readonly getUserService: GetUserService;
  readonly listUsersCursorService: ListUsersCursorService;
  readonly listUsersService: ListUsersService;
  readonly updateUserService: UpdateUserService;
}

const EntityTagResponseHeader = {
  ETag: {
    description: "Strong validator for the returned user representation",
    schema: { type: "string", example: '"v1"' },
  },
} as const;

const CreatedResourceLocationResponseHeader = {
  Location: {
    description: "URI reference for the created user resource",
    schema: {
      type: "string",
      example: "/users/550e8400-e29b-41d4-a716-446655440000",
    },
  },
} as const;

const UserRevalidationCacheResponseHeader = {
  "Cache-Control": {
    description:
      "Private-cache revalidation policy for the tenant-scoped user representation",
    schema: { type: "string", example: "private, no-cache" },
  },
} as const;

const UserListCacheResponseHeader = {
  "Cache-Control": {
    description:
      "Tenant-scoped user lists are private and must not be stored by caches",
    schema: { type: "string", example: "private, no-store" },
  },
} as const;

const CursorNextLinkResponseHeader = {
  Link: {
    description:
      'RFC 8288 next-page link when another cursor page is available; omitted on the final page',
    schema: {
      type: "string",
      example:
        '</users/cursor?limit=20&cursor=eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTA5LTI0VDAwOjAwOjAwLjAwMFoiLCJpZCI6IjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMCJ9>; rel="next"',
    },
  },
} as const;

const RateLimitResponseHeaders = {
  "RateLimit-Policy": {
    description:
      "Provisional quota policy field following draft-ietf-httpapi-ratelimit-headers-11 when rate limiting is enabled",
    schema: { type: "string" },
  },
  RateLimit: {
    description:
      "Provisional current quota field following draft-ietf-httpapi-ratelimit-headers-11 when rate limiting is enabled",
    schema: { type: "string" },
  },
} as const;

const RateLimitExceededResponseHeaders = {
  ...RateLimitResponseHeaders,
  "Retry-After": {
    description: "Seconds to wait before retrying a rate-limited request",
    schema: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
} as const;

const DatabaseFailureResponses = {
  503: {
    description: "Database is temporarily busy or unavailable",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
  504: {
    description: "Database operation timed out",
    content: { "application/json": { schema: ErrorResponseSchema } },
  },
} as const;

const createUserRoute = createRoute({
  method: "post",
  path: "/users",
  tags: ["Users"],
  request: {
    headers: IdempotencyKeyHeadersSchema,
    body: {
      required: true,
      content: { "application/json": { schema: CreateUserRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "User created or idempotently replayed",
      headers: {
        ...RateLimitResponseHeaders,
        ...EntityTagResponseHeader,
        ...CreatedResourceLocationResponseHeader,
      },
      content: { "application/json": { schema: UserResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required or credentials invalid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal lacks tenant access or the required scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Email already exists within the tenant",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    413: {
      description: "Request body too large",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Idempotency key was already used with a different request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      headers: RateLimitExceededResponseHeaders,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    ...DatabaseFailureResponses,
  },
});

const listUsersRoute = createRoute({
  method: "get",
  path: "/users",
  tags: ["Users"],
  request: { query: PaginationQuerySchema },
  responses: {
    200: {
      description: "Tenant-scoped paginated users",
      headers: {
        ...RateLimitResponseHeaders,
        ...UserListCacheResponseHeader,
      },
      content: { "application/json": { schema: UserListResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required or credentials invalid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal lacks tenant access or the required scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      headers: RateLimitExceededResponseHeaders,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    ...DatabaseFailureResponses,
  },
});

const listUsersCursorRoute = createRoute({
  method: "get",
  path: "/users/cursor",
  tags: ["Users"],
  request: { query: CursorPaginationQuerySchema },
  responses: {
    200: {
      description: "Tenant-scoped cursor-paginated users",
      headers: {
        ...RateLimitResponseHeaders,
        ...UserListCacheResponseHeader,
        ...CursorNextLinkResponseHeader,
      },
      content: { "application/json": { schema: UserCursorListResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required or credentials invalid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal lacks tenant access or the required scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      headers: RateLimitExceededResponseHeaders,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    ...DatabaseFailureResponses,
  },
});

const updateUserRoute = createRoute({
  method: "patch",
  path: "/users/{id}",
  tags: ["Users"],
  request: {
    headers: IfMatchHeadersSchema,
    params: UserPathParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateUserRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated user",
      headers: { ...RateLimitResponseHeaders, ...EntityTagResponseHeader },
      content: { "application/json": { schema: UserResponseSchema } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required or credentials invalid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal lacks tenant access or the required scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "User not found in the current tenant",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    409: {
      description: "Email already exists within the tenant",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    413: {
      description: "Request body too large",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    412: {
      description: "If-Match did not match the current user representation",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    428: {
      description: "If-Match is required to prevent lost updates",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      headers: RateLimitExceededResponseHeaders,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    ...DatabaseFailureResponses,
  },
});

const deleteUserRoute = createRoute({
  method: "delete",
  path: "/users/{id}",
  tags: ["Users"],
  request: {
    headers: IfMatchHeadersSchema,
    params: UserPathParamsSchema,
  },
  responses: {
    204: {
      description: "User deleted",
      headers: RateLimitResponseHeaders,
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required or credentials invalid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal lacks tenant access or the required scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "User not found in the current tenant",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    412: {
      description: "If-Match did not match the current user representation",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    428: {
      description: "If-Match is required to prevent stale deletion",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      headers: RateLimitExceededResponseHeaders,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    ...DatabaseFailureResponses,
  },
});

const getUserRoute = createRoute({
  method: "get",
  path: "/users/{id}",
  tags: ["Users"],
  request: {
    headers: IfNoneMatchHeadersSchema,
    params: UserPathParamsSchema,
  },
  responses: {
    200: {
      description: "User",
      headers: {
        ...RateLimitResponseHeaders,
        ...EntityTagResponseHeader,
        ...UserRevalidationCacheResponseHeader,
      },
      content: { "application/json": { schema: UserResponseSchema } },
    },
    304: {
      description: "User representation has not changed",
      headers: {
        ...RateLimitResponseHeaders,
        ...EntityTagResponseHeader,
        ...UserRevalidationCacheResponseHeader,
      },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Authentication required or credentials invalid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Authenticated principal lacks tenant access or the required scope",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "User not found in the current tenant",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Rate limit exceeded",
      headers: RateLimitExceededResponseHeaders,
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    ...DatabaseFailureResponses,
  },
});

export function registerUserRoutes(app: OpenAPIHono<AppEnv>, dependencies: UserRouteDependencies): void {
  app.openapi(createUserRoute, async (c) => {
    const input = c.req.valid("json");
    const { "idempotency-key": idempotencyKey } = c.req.valid("header");
    const user = await dependencies.createUserService.execute(
      input,
      c.get("requestContext"),
      idempotencyKey === undefined ? {} : { idempotencyKey },
    );
    const response = UserResponseSchema.parse(toUserResponse(user));
    c.header("Location", `/users/${user.id}`);
    c.header("ETag", formatUserEntityTag(user.version));
    return c.json(response, 201);
  });

  app.openapi(listUsersRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await dependencies.listUsersService.execute(query, c.get("requestContext"));
    const response = UserListResponseSchema.parse({
      data: result.users.map(toUserResponse),
      meta: result.meta,
    });
    c.header("Cache-Control", "private, no-store");
    return c.json(response, 200);
  });

  app.openapi(listUsersCursorRoute, async (c) => {
    const { cursor, limit } = c.req.valid("query");
    const result = await dependencies.listUsersCursorService.execute(
      {
        ...(cursor === undefined ? {} : { after: decodeUserListCursor(cursor) }),
        limit,
      },
      c.get("requestContext"),
    );
    const nextCursor =
      result.meta.next === undefined ? null : encodeUserListCursor(result.meta.next);
    const response = UserCursorListResponseSchema.parse({
      data: result.users.map(toUserResponse),
      meta: {
        limit: result.meta.limit,
        nextCursor,
      },
    });
    c.header("Cache-Control", "private, no-store");
    if (nextCursor !== null) {
      c.header("Link", formatUserListNextLink(nextCursor, result.meta.limit));
    }
    return c.json(response, 200);
  });

  app.openapi(updateUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const { "if-match": ifMatch } = c.req.valid("header");
    const canonicalId = CanonicalUuidSchema.parse(id);
    const user = await dependencies.updateUserService.execute(
      canonicalId,
      input,
      ifMatch === undefined ? undefined : parseUserIfMatch(ifMatch),
      c.get("requestContext"),
    );
    const response = UserResponseSchema.parse(toUserResponse(user));
    c.header("ETag", formatUserEntityTag(user.version));
    return c.json(response, 200);
  });

  app.openapi(deleteUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { "if-match": ifMatch } = c.req.valid("header");
    const canonicalId = CanonicalUuidSchema.parse(id);
    await dependencies.deleteUserService.execute(
      canonicalId,
      ifMatch === undefined ? undefined : parseUserIfMatch(ifMatch),
      c.get("requestContext"),
    );
    return c.body(null, 204);
  });

  app.openapi(getUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { "if-none-match": ifNoneMatch } = c.req.valid("header");
    const canonicalId = CanonicalUuidSchema.parse(id);
    const user = await dependencies.getUserService.execute(canonicalId, c.get("requestContext"));
    c.header("Cache-Control", "private, no-cache");
    c.header("ETag", formatUserEntityTag(user.version));
    if (ifNoneMatch !== undefined && userIfNoneMatchMatches(ifNoneMatch, user.version)) {
      return c.body(null, 304);
    }
    const response = UserResponseSchema.parse(toUserResponse(user));
    return c.json(response, 200);
  });
}
