import { z } from "@hono/zod-openapi";

export const IfMatchHeaderSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .openapi({
    example: '"v1"',
    description: "RFC 9110 If-Match entity-tag precondition.",
  });

export const IfMatchHeadersSchema = z.object({
  "if-match": IfMatchHeaderSchema.optional(),
});

export const IfNoneMatchHeaderSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .openapi({
    example: '"v1"',
    description: "RFC 9110 If-None-Match entity-tag cache validator.",
  });

export const IfNoneMatchHeadersSchema = z.object({
  "if-none-match": IfNoneMatchHeaderSchema.optional(),
});
