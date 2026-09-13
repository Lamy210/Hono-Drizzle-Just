import { z } from "@hono/zod-openapi";
import { TraceIdSchema, UuidSchema } from "./primitives";

export const ErrorDetailSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
    requestId: UuidSchema,
    traceId: TraceIdSchema,
  })
  .openapi("ErrorResponse");
