import { expect, test } from "bun:test";
import { JsonConsoleLogger } from "../../../src/infrastructure/logging/json-console-logger";

test("reserved log fields cannot be overridden by structured context", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger(
    {
      timestamp: "forged-base-timestamp",
      level: "error",
      message: "forged-base-message",
      service: "template",
    },
    (line) => lines.push(line),
  );

  logger.child({
    timestamp: "forged-child-timestamp",
    level: "debug",
    message: "forged-child-message",
  }).warn("actual message", {
    timestamp: "forged-call-timestamp",
    level: "info",
    message: "forged-call-message",
    requestId: "req-1",
  });

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.timestamp).not.toBe("forged-base-timestamp");
  expect(entry.timestamp).not.toBe("forged-child-timestamp");
  expect(entry.timestamp).not.toBe("forged-call-timestamp");
  expect(entry.level).toBe("warn");
  expect(entry.message).toBe("actual message");
  expect(entry.service).toBe("template");
  expect(entry.requestId).toBe("req-1");
});
