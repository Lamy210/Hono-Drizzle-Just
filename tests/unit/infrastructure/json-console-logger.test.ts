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

test("redaction normalizes common credential key casing and separators", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));

  logger.info("credential shapes", {
    client_secret: "client-secret",
    clientSecret: "client-secret-camel",
    "private-key": "private-key",
    privateKey: "private-key-camel",
    accessToken: "access-token",
    "refresh-token": "refresh-token",
    id_token: "id-token",
    sessionToken: "session-token",
    API_KEY: "api-key",
    xApiKey: "x-api-key",
    set_cookie: "session=secret",
    nested: [{ secret_key: "nested-secret" }],
  });

  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.client_secret).toBe("[REDACTED]");
  expect(entry.clientSecret).toBe("[REDACTED]");
  expect(entry["private-key"]).toBe("[REDACTED]");
  expect(entry.privateKey).toBe("[REDACTED]");
  expect(entry.accessToken).toBe("[REDACTED]");
  expect(entry["refresh-token"]).toBe("[REDACTED]");
  expect(entry.id_token).toBe("[REDACTED]");
  expect(entry.sessionToken).toBe("[REDACTED]");
  expect(entry.API_KEY).toBe("[REDACTED]");
  expect(entry.xApiKey).toBe("[REDACTED]");
  expect(entry.set_cookie).toBe("[REDACTED]");
  expect(entry.nested).toEqual([{ secret_key: "[REDACTED]" }]);
});

test("redaction does not treat unrelated key-like fields as credentials", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));

  logger.info("non-secret identifiers", {
    keyHash: "explicitly-managed-elsewhere",
    publicKeyId: "kid-123",
    keyboardLayout: "jp",
    monkey: "business-value",
  });

  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.keyHash).toBe("explicitly-managed-elsewhere");
  expect(entry.publicKeyId).toBe("kid-123");
  expect(entry.keyboardLayout).toBe("jp");
  expect(entry.monkey).toBe("business-value");
});

test("URL log values remove userinfo, fragments, and redact sensitive query parameters", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const url = new URL(
    "https://client:password@example.test/resource/123?access_token=token-value&client_secret=client-value&filter=active#id_token=fragment-secret",
  );

  logger.info("upstream URL", { url });

  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(typeof entry.url).toBe("string");

  const sanitized = new URL(String(entry.url));
  expect(sanitized.username).toBe("");
  expect(sanitized.password).toBe("");
  expect(sanitized.hash).toBe("");
  expect(sanitized.searchParams.get("access_token")).toBe("[REDACTED]");
  expect(sanitized.searchParams.get("client_secret")).toBe("[REDACTED]");
  expect(sanitized.searchParams.get("filter")).toBe("active");

  const serialized = lines[0] ?? "";
  expect(serialized).not.toContain("client:password");
  expect(serialized).not.toContain("token-value");
  expect(serialized).not.toContain("client-value");
  expect(serialized).not.toContain("fragment-secret");
});

test("URL query redaction preserves repeated parameter order without leaking secret values", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const url = new URL(
    "https://example.test/callback?scope=read&accessToken=first&scope=write&accessToken=second",
  );

  logger.info("callback URL", { callbackUrl: url });

  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  const sanitized = new URL(String(entry.callbackUrl));
  expect([...sanitized.searchParams.entries()]).toEqual([
    ["scope", "read"],
    ["accessToken", "[REDACTED]"],
    ["scope", "write"],
    ["accessToken", "[REDACTED]"],
  ]);
  expect(lines[0]).not.toContain("first");
  expect(lines[0]).not.toContain("second");
});

test("circular log context falls back to a minimal safe log entry", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const circular: Record<string, unknown> = { requestId: "req-secret" };
  circular.self = circular;

  expect(() => logger.info("circular context", { payload: circular })).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(typeof entry.timestamp).toBe("string");
  expect(entry.level).toBe("info");
  expect(entry.message).toBe("circular context");
  expect(entry.contextSerializationFailed).toBe(true);
  expect(entry.payload).toBeUndefined();
  expect(lines[0]).not.toContain("req-secret");
});

test("throwing context getters fall back without leaking the original failure", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const payload = Object.defineProperty({}, "token", {
    enumerable: true,
    get(): never {
      throw new Error("getter contained sensitive detail");
    },
  });

  expect(() => logger.warn("throwing getter", { payload })).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.level).toBe("warn");
  expect(entry.message).toBe("throwing getter");
  expect(entry.contextSerializationFailed).toBe(true);
  expect(entry.payload).toBeUndefined();
  expect(lines[0]).not.toContain("sensitive detail");
});

test("non-JSON context values fall back to a minimal safe log entry", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));

  expect(() => logger.error("bigint context", { sequence: 1n })).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.level).toBe("error");
  expect(entry.message).toBe("bigint context");
  expect(entry.contextSerializationFailed).toBe(true);
  expect(entry.sequence).toBeUndefined();
});

test("serializable non-string runtime messages use a safe placeholder", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));

  logger.info(42 as unknown as string, { requestId: "req-1" });

  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.message).toBe("[INVALID_LOG_MESSAGE]");
  expect(entry.requestId).toBe("req-1");
});

test("BigInt runtime messages do not escape JSON serialization", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));

  expect(() => logger.warn(1n as unknown as string)).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.message).toBe("[INVALID_LOG_MESSAGE]");
});

test("circular runtime messages do not escape JSON serialization", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const circular: Record<string, unknown> = { secret: "do-not-log" };
  circular.self = circular;

  expect(() => logger.error(circular as unknown as string)).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.message).toBe("[INVALID_LOG_MESSAGE]");
  expect(lines[0]).not.toContain("do-not-log");
});

test("context serialization fallback stays safe with a malformed runtime message", () => {
  const lines: string[] = [];
  const logger = new JsonConsoleLogger({}, (line) => lines.push(line));
  const payload = Object.defineProperty({}, "token", {
    enumerable: true,
    get(): never {
      throw new Error("sensitive provider detail");
    },
  });

  expect(() => logger.info(1n as unknown as string, { payload })).not.toThrow();

  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(entry.message).toBe("[INVALID_LOG_MESSAGE]");
  expect(entry.contextSerializationFailed).toBe(true);
  expect(entry.payload).toBeUndefined();
  expect(lines[0]).not.toContain("sensitive provider detail");
});

test("log sink failures remain strict", () => {
  const sinkError = new Error("sink unavailable");
  const logger = new JsonConsoleLogger({}, () => {
    throw sinkError;
  });

  expect(() => logger.info("sink failure")).toThrow(sinkError);
});
