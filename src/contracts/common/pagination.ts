import { z } from "@hono/zod-openapi";

export const PaginationQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(1)
    .openapi({
      param: { name: "page", in: "query" },
      example: 1,
      description: "1-based page number, capped to bound offset pagination cost",
    }),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({
      param: { name: "perPage", in: "query" },
      example: 20,
      description: "Number of users returned per page",
    }),
});

export const PaginationMetaSchema = z
  .object({
    page: z.number().int().min(1),
    perPage: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  })
  .openapi("PaginationMeta");
