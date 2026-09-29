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

