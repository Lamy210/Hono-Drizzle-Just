import { describe, expect, test } from "bun:test";
import {
  CanonicalUuidSchema,
  SpanIdSchema,
  TraceIdSchema,
} from "../../../src/contracts/common/primitives";

describe("CanonicalUuidSchema", () => {
  test("accepts an uppercase UUID and normalizes it to lowercase", () => {
    expect(CanonicalUuidSchema.parse("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("rejects a UUID-shaped value with an invalid RFC variant", () => {
    expect(() => CanonicalUuidSchema.parse("00000000-0000-0000-0000-000000000001")).toThrow();
  });
});

describe("W3C trace identifiers", () => {
  test("accepts valid lowercase trace and span IDs", () => {
    expect(TraceIdSchema.parse("4bf92f3577b34da6a3ce929d0e0e4736")).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
    expect(SpanIdSchema.parse("00f067aa0ba902b7")).toBe("00f067aa0ba902b7");
  });

  test("rejects uppercase and all-zero trace IDs", () => {
    expect(() => TraceIdSchema.parse("4BF92F3577B34DA6A3CE929D0E0E4736")).toThrow();
    expect(() => TraceIdSchema.parse("00000000000000000000000000000000")).toThrow();
  });
});
