import { z } from "@hono/zod-openapi";

export const UuidSchema = z.uuid().openapi({
  example: "550e8400-e29b-41d4-a716-446655440000",
  description: "RFC 9562 UUID. Hexadecimal letters are case-insensitive on input.",
});

export const CanonicalUuidSchema = UuidSchema.transform((value) => value.toLowerCase());

export const EmailSchema = z.email().openapi({ example: "lamy@example.com" });

export const DateTimeSchema = z.iso.datetime().openapi({ example: "2026-09-13T00:00:00.000Z" });

export const TraceIdSchema = z
  .string()
  .length(32, "traceId must be 32 lowercase hexadecimal characters and non-zero")
  .regex(
    /^[0-9a-f]*[1-9a-f][0-9a-f]*$/,
    "traceId must be 32 lowercase hexadecimal characters and non-zero",
  )
  .openapi({ example: "4bf92f3577b34da6a3ce929d0e0e4736" });

export const SpanIdSchema = z
  .string()
  .length(16, "spanId must be 16 lowercase hexadecimal characters and non-zero")
  .regex(
    /^[0-9a-f]*[1-9a-f][0-9a-f]*$/,
    "spanId must be 16 lowercase hexadecimal characters and non-zero",
  )
  .openapi({ example: "00f067aa0ba902b7" });
