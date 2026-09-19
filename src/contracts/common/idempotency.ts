import { z } from "@hono/zod-openapi";

function isVisibleAscii(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isVisibleAscii, { message: "must contain only visible ASCII characters" })
  .openapi({ example: "550e8400-e29b-41d4-a716-446655440000" });

export const IdempotencyKeyHeadersSchema = z.object({
  "idempotency-key": IdempotencyKeySchema.optional(),
});
