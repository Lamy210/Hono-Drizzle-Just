import { createMiddleware } from "hono/factory";
import type { Logger } from "../../core/logging/logger";
import { CanonicalUuidSchema } from "../../contracts/common/primitives";
import type { AppEnv } from "../env";
import {
  createRequestTrace,
  formatTraceParent,
} from "../../infrastructure/tracing/w3c-trace-context";

export function createRequestContextMiddleware(rootLogger: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const incomingRequestId = CanonicalUuidSchema.safeParse(c.req.header("x-request-id"));
    const requestId = incomingRequestId.success ? incomingRequestId.data : crypto.randomUUID().toLowerCase();
    const trace = createRequestTrace(c.req.header("traceparent") ?? null, c.req.header("tracestate"));
    const requestContext = {
      requestId,
      trace,
      startedAt: performance.now(),
    };
    const logger = rootLogger.child({ requestId, traceId: trace.traceId, spanId: trace.spanId });

    c.set("requestContext", requestContext);
    c.set("logger", logger);
    c.header("x-request-id", requestId);
    c.header("traceparent", formatTraceParent(trace));
    await next();
  });
}
