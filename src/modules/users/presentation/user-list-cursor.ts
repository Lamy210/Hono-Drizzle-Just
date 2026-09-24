import { z } from "@hono/zod-openapi";
import { AppError } from "../../../core/errors/app-error";
import { CanonicalUuidSchema } from "../../../contracts/common/primitives";
import type { UserListCursor } from "../application/user-cursor-list.repository";

const CursorPayloadSchema = z.object({
  v: z.literal(1),
  createdAt: z.iso.datetime(),
  id: CanonicalUuidSchema,
});

export function encodeUserListCursor(cursor: UserListCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id.toLowerCase(),
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeUserListCursor(value: string): UserListCursor {
  try {
    const payload = CursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    const createdAt = new Date(payload.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error("invalid cursor timestamp");
    }
    return { createdAt, id: payload.id };
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid cursor", 400);
  }
}
