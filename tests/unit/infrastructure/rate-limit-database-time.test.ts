import { expect, test } from "bun:test";
import { databaseTimestampMs } from "../../../src/infrastructure/rate-limit/database-time";

test("parses PostgreSQL timestamps into finite milliseconds", () => {
  expect(databaseTimestampMs("2026-09-25 00:00:00+00")).toBe(
    Date.parse("2026-09-25 00:00:00+00"),
  );
});

test("rejects invalid database timestamps", () => {
  expect(() => databaseTimestampMs("not-a-timestamp")).toThrow(
    "Rate limiter received an invalid database timestamp",
  );
});
