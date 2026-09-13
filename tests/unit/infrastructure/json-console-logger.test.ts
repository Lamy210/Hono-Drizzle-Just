import { expect, test } from "bun:test";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

test("child logger keeps context and redacts sensitive fields recursively", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({ service: "template" }, (line) => lines.push(line));

  logger.child({ requestId: "req-1" }).info("created user", {
    userId: "user-1",
    authorization: "Bearer secret",
    nested: { password: "secret-password" },
  });

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.service).toBe("template");
  expect(entry.requestId).toBe("req-1");
  expect(entry.userId).toBe("user-1");
  expect(entry.authorization).toBe("[REDACTED]");
  expect(entry.nested).toEqual({ password: "[REDACTED]" });
});
