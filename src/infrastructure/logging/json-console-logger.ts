import type { LogContext, Logger, LogLevel } from "../../core/logging/logger";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const INVALID_LOG_MESSAGE = "[INVALID_LOG_MESSAGE]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "xapikey",
  "apikey",
  "password",
  "passwd",
  "passphrase",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "secret",
  "clientsecret",
  "privatekey",
  "secretkey",
]);

export type LogSink = (line: string) => void;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

function safeErrorName(error: Error): string {
  try {
    const name = Reflect.get(error, "name");
    return typeof name === "string" && name.length > 0 ? name : "Error";
  } catch {
    return "Error";
  }
}

function sanitizeUrl(value: URL): string {
  const sanitized = new URL(value.toString());
  sanitized.username = "";
  sanitized.password = "";
  sanitized.hash = "";

  const entries = [...sanitized.searchParams.entries()];
  sanitized.search = "";
  for (const [queryKey, queryValue] of entries) {
    sanitized.searchParams.append(
      queryKey,
      SENSITIVE_KEYS.has(normalizedKey(queryKey)) ? "[REDACTED]" : queryValue,
    );
  }

  return sanitized.toString();
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEYS.has(normalizedKey(key))) {
    return "[REDACTED]";
  }
  if (value instanceof Error) {
    return { name: safeErrorName(value) };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URL) {
    return sanitizeUrl(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]),
    );
  }
  return value;
}

export class JsonConsoleLogger implements Logger {
  constructor(
    private readonly baseContext: LogContext = {},
    private readonly sink: LogSink = (line) => console.log(line),
    private readonly minimumLevel: LogLevel = "info",
  ) {}

  debug(message: string, context: LogContext = {}): void {
    this.write("debug", message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.write("info", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write("warn", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.write("error", message, context);
  }

  child(context: LogContext): Logger {
    return new JsonConsoleLogger({ ...this.baseContext, ...context }, this.sink, this.minimumLevel);
  }

  private write(level: LogLevel, message: string, context: LogContext): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minimumLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const safeMessage = typeof message === "string" ? message : INVALID_LOG_MESSAGE;
    let line: string;
    try {
      line = JSON.stringify(
        sanitize({
          ...this.baseContext,
          ...context,
          timestamp,
          level,
          message: safeMessage,
        }),
      );
    } catch {
      line = JSON.stringify({
        timestamp,
        level,
        message: safeMessage,
        contextSerializationFailed: true,
      });
    }

    this.sink(line);
  }
}
