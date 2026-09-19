import { expect, test } from "bun:test";

test("idempotency keys preserve valid visible ASCII values", async () => {
  const modulePath = "../../../src/contracts/common/idempotency";
  const module = await import(modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  expect(module.IdempotencyKeySchema.parse("Key-A")).toBe("Key-A");
  expect(module.IdempotencyKeySchema.parse("!~")).toBe("!~");
  expect(module.IdempotencyKeySchema.parse("x".repeat(255))).toBe("x".repeat(255));
});

test("idempotency keys reject empty, oversized, whitespace, controls, and Unicode", async () => {
  const modulePath = "../../../src/contracts/common/idempotency";
  const module = await import(modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  for (const value of [
    "",
    "x".repeat(256),
    "a b",
    "a\tb",
    "a\nb",
    `a${String.fromCharCode(0x7f)}b`,
    "é",
  ]) {
    expect(() => module.IdempotencyKeySchema.parse(value)).toThrow();
  }
});

test("header schema keeps Idempotency-Key optional and uses the canonical lowercase key", async () => {
  const modulePath = "../../../src/contracts/common/idempotency";
  const module = await import(modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  expect(module.IdempotencyKeyHeadersSchema.parse({})).toEqual({});
  expect(
    module.IdempotencyKeyHeadersSchema.parse({ "idempotency-key": "Request-Key-123" }),
  ).toEqual({ "idempotency-key": "Request-Key-123" });
});
