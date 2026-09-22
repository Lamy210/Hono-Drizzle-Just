import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorResponseSchema } from "../../../contracts/common/errors";
import { IdempotencyKeyHeadersSchema } from "../../../contracts/common/idempotency";
import { PaginationQuerySchema } from "../../../contracts/common/pagination";
import { CanonicalUuidSchema } from "../../../contracts/common/primitives";
import {
  CreateUserRequestSchema,
  UserListResponseSchema,
  UserPathParamsSchema,
  UserResponseSchema,
} from "../../../contracts/users/user.contracts";
import type { AppEnv } from "../../../http/env";
import type { CreateUserService } from "../application/create-user.service";
import type { GetUserService } from "../application/get-user.service";
import type { ListUsersService } from "../application/list-users.service";
import { toUserResponse } from "./user.presenter";

export interface UserRouteDependencies {
  readonly createUserService: CreateUserService;
  readonly getUserService: GetUserService;
  readonly listUsersService: ListUsersService;
}

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
      headers: RateLimitResponseHeaders,
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
      headers: RateLimitResponseHeaders,
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

const getUserRoute = createRoute({
  method: "get",
  path: "/users/{id}",
  tags: ["Users"],
  request: { params: UserPathParamsSchema },
  responses: {
    200: {
      description: "User",
      headers: RateLimitResponseHeaders,
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
    return c.json(response, 201);
  });

  app.openapi(listUsersRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await dependencies.listUsersService.execute(query, c.get("requestContext"));
    const response = UserListResponseSchema.parse({
      data: result.users.map(toUserResponse),
      meta: result.meta,
    });
    return c.json(response, 200);
  });

  app.openapi(getUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const canonicalId = CanonicalUuidSchema.parse(id);
    const user = await dependencies.getUserService.execute(canonicalId, c.get("requestContext"));
    const response = UserResponseSchema.parse(toUserResponse(user));
    return c.json(response, 200);
  });
}
