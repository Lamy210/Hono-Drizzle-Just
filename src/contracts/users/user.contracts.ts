import { z } from "@hono/zod-openapi";
import { PaginationMetaSchema } from "../common/pagination";
import { DateTimeSchema, EmailSchema, UuidSchema } from "../common/primitives";

export const CreateUserRequestSchema = z
  .object({
    email: EmailSchema,
    name: z.string().trim().min(1).max(100).openapi({ example: "Lamy" }),
  })
  .openapi("CreateUserRequest");

export const UpdateUserRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    name: z.string().trim().min(1).max(100).openapi({ example: "Updated Lamy" }).optional(),
  })
  .refine((value) => value.email !== undefined || value.name !== undefined, {
    message: "At least one of email or name is required",
  })
  .openapi("UpdateUserRequest");

export const UserResponseSchema = z
  .object({
    id: UuidSchema,
    email: EmailSchema,
    name: z.string(),
    createdAt: DateTimeSchema,
  })
  .openapi("UserResponse");

export const UserListResponseSchema = z
  .object({
    data: z.array(UserResponseSchema),
    meta: PaginationMetaSchema,
  })
  .openapi("UserListResponse");

export const UserPathParamsSchema = z.object({
  id: z.uuid().openapi({
    param: { name: "id", in: "path" },
    example: "550e8400-e29b-41d4-a716-446655440000",
  }),
});
