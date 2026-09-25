import { expect, test } from "bun:test";
import {
  decodeUserListCursor,
  encodeUserListCursor,
  formatUserListNextLink,
} from "../../../../src/modules/users/presentation/user-list-cursor";

test("cursor codec round-trips a canonical keyset position without tenant data", () => {
  const position = {
    createdAt: new Date("2026-09-24T12:34:56.789Z"),
    id: "550E8400-E29B-41D4-A716-446655440000",
  };

  const encoded = encodeUserListCursor(position);
  const decoded = decodeUserListCursor(encoded);

  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decoded).toEqual({
    createdAt: position.createdAt,
    id: "550e8400-e29b-41d4-a716-446655440000",
  });
  expect(Buffer.from(encoded, "base64url").toString("utf8")).not.toContain("tenant");
});

test("cursor decoder fails closed with a sanitized validation error", () => {
  for (const cursor of [
    "not-json",
    Buffer.from(JSON.stringify({ v: 2, createdAt: "2026-09-24T00:00:00.000Z", id: crypto.randomUUID() })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: "nope", id: crypto.randomUUID() })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: "2026-09-24T00:00:00.000Z", id: "not-a-uuid" })).toString("base64url"),
  ]) {
    expect(() => decodeUserListCursor(cursor)).toThrow();
    try {
      decodeUserListCursor(cursor);
    } catch (error) {
      expect(error).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Invalid cursor",
        status: 400,
      });
      expect(String(error)).not.toContain("not-a-uuid");
    }
  }
});

test("cursor next link uses an RFC 8288 relative next relation", () => {
  const cursor = encodeUserListCursor({
    createdAt: new Date("2026-09-24T12:34:56.789Z"),
    id: "550e8400-e29b-41d4-a716-446655440000",
  });

  expect(formatUserListNextLink(cursor, 25)).toBe(
    `</users/cursor?limit=25&cursor=${cursor}>; rel="next"`,
  );
});

