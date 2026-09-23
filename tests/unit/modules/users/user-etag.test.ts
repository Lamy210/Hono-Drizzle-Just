import { expect, test } from "bun:test";
import {
  formatUserEntityTag,
  parseUserIfMatch,
  userIfNoneMatchMatches,
} from "../../../../src/modules/users/presentation/user-etag";

test("formats positive user versions as strong entity tags", () => {
  expect(formatUserEntityTag(1)).toBe('"v1"');
  expect(formatUserEntityTag(42)).toBe('"v42"');
  expect(() => formatUserEntityTag(0)).toThrow();
  expect(() => formatUserEntityTag(Number.NaN)).toThrow();
});

test("parses a returned strong entity tag into a version precondition", () => {
  expect(parseUserIfMatch('"v7"')).toEqual({
    kind: "versions",
    versions: [7],
  });
});

test("If-Match wildcard selects any current representation", () => {
  expect(parseUserIfMatch("*")).toEqual({ kind: "any-current" });
});

test("weak entity tags never satisfy the strong If-Match comparison", () => {
  expect(parseUserIfMatch('W/"v7"')).toEqual({
    kind: "versions",
    versions: [],
  });
});

test("multiple entity tags preserve recognized user versions and ignore unrelated tags", () => {
  expect(parseUserIfMatch('"v7", "opaque,tag", "v9", "v7"')).toEqual({
    kind: "versions",
    versions: [7, 9],
  });
});

test("malformed If-Match syntax is rejected as request validation", () => {
  for (const value of ["", ',"v1"', '"v1",', '"unterminated', '*,"v1"', '"a"b"']) {
    expect(() => parseUserIfMatch(value)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR", status: 400 }),
    );
  }
});

test("If-None-Match uses weak comparison for the current user version", () => {
  expect(userIfNoneMatchMatches('"v7"', 7)).toBe(true);
  expect(userIfNoneMatchMatches('W/"v7"', 7)).toBe(true);
  expect(userIfNoneMatchMatches('"v6", W/"v7"', 7)).toBe(true);
  expect(userIfNoneMatchMatches('"v6"', 7)).toBe(false);
});

test("If-None-Match wildcard matches any existing user representation", () => {
  expect(userIfNoneMatchMatches("*", 7)).toBe(true);
});

test("unrelated entity tags do not match the user validator", () => {
  expect(userIfNoneMatchMatches('"opaque", W/"other"', 7)).toBe(false);
});

test("malformed If-None-Match syntax is rejected as request validation", () => {
  for (const value of ["", ',"v1"', '"v1",', '"unterminated', '*,"v1"', '"a"b"']) {
    expect(() => userIfNoneMatchMatches(value, 1)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR", status: 400 }),
    );
  }
});
