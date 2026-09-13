import type { LogContext, Logger, LogLevel } from "../../core/logging/logger";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
]);

export type LogSink = (line: string) => void;

function sanitize(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URL) {
    return value.toString();
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
    const payload = sanitize({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.baseContext,
      ...context,
    });
    this.sink(JSON.stringify(payload));
  }
}
