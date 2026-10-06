import { expect, test } from "bun:test";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

test("Error context keeps only stable type information", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const error = new TypeError("provider failed with token=super-secret");

  logger.error("upstream failure", { error, requestId: "req-1" });

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.error).toEqual({ name: "TypeError" });
  expect(entry.requestId).toBe("req-1");
  expect(lines[0]).not.toContain("provider failed");
  expect(lines[0]).not.toContain("super-secret");
  expect(lines[0]).not.toContain("json-console-logger-error-safety.test.ts");
});

test("throwing Error name getters fall back without discarding other context", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const error = Object.defineProperty(new Error("provider-private detail"), "name", {
    configurable: true,
    get(): never {
      throw new Error("name getter leaked secret");
    },
  });

  expect(() => logger.warn("provider warning", { error, requestId: "req-2" })).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.error).toEqual({ name: "Error" });
  expect(entry.requestId).toBe("req-2");
  expect(entry.contextSerializationFailed).toBeUndefined();
  expect(lines[0]).not.toContain("provider-private detail");
  expect(lines[0]).not.toContain("name getter leaked secret");
});

test("invalid Date context values fall back without discarding other context", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));

  expect(() =>
    logger.info("invalid date", { occurredAt: new Date(Number.NaN), requestId: "req-3" }),
  ).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.occurredAt).toBe("[INVALID_DATE]");
  expect(entry.requestId).toBe("req-3");
  expect(entry.contextSerializationFailed).toBeUndefined();
});
