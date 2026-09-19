import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorResponseSchema } from "../../../contracts/common/errors";
import { IdempotencyKeyHeadersSchema } from "../../../contracts/common/idempotency";
import { CanonicalUuidSchema } from "../../../contracts/common/primitives";
import {
  CreateUserRequestSchema,
  UserPathParamsSchema,
  UserResponseSchema,
} from "../../../contracts/users/user.contracts";
import type { AppEnv } from "../../../http/env";
import type { CreateUserService } from "../application/create-user.service";
import type { GetUserService } from "../application/get-user.service";
import { toUserResponse } from "./user.presenter";

export interface UserRouteDependencies {
  readonly createUserService: CreateUserService;
  readonly getUserService: GetUserService;
}

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

  app.openapi(getUserRoute, async (c) => {
    const { id } = c.req.valid("param");
    const canonicalId = CanonicalUuidSchema.parse(id);
    const user = await dependencies.getUserService.execute(canonicalId, c.get("requestContext"));
    const response = UserResponseSchema.parse(toUserResponse(user));
    return c.json(response, 200);
  });
}
