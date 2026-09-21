import { expect, test } from "bun:test";
import { PaginationQuerySchema } from "../../../src/contracts/common/pagination";

test("pagination query applies bounded defaults and coerces query strings", () => {
  expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, perPage: 20 });
  expect(PaginationQuerySchema.parse({ page: "2", perPage: "50" })).toEqual({
    page: 2,
    perPage: 50,
  });
});

test("pagination query rejects invalid and excessively deep pages", () => {
  for (const input of [
    { page: "0" },
    { page: "10001" },
    { perPage: "0" },
    { perPage: "101" },
    { page: "not-a-number" },
  ]) {
    expect(() => PaginationQuerySchema.parse(input)).toThrow();
  }
});
