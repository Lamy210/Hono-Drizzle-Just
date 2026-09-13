import { createMiddleware } from "hono/factory";
import type { PrincipalResolver } from "../../core/auth/principal-resolver";
import type { RequestContext } from "../../core/context/request-context";
import type { Logger } from "../../core/logging/logger";
import { CanonicalUuidSchema } from "../../contracts/common/primitives";
import type { AppEnv } from "../env";
import {
  createRequestTrace,
  formatTraceParent,
} from "../../infrastructure/tracing/w3c-trace-context";

export function createRequestContextMiddleware(
  rootLogger: Logger,
  principalResolver?: PrincipalResolver,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const incomingRequestId = CanonicalUuidSchema.safeParse(c.req.header("x-request-id"));
    const requestId = incomingRequestId.success ? incomingRequestId.data : crypto.randomUUID().toLowerCase();
    const trace = createRequestTrace(c.req.header("traceparent") ?? null, c.req.header("tracestate"));
    const baseRequestContext: RequestContext = {
      requestId,
      trace,
      startedAt: performance.now(),
    };
    const baseLogger = rootLogger.child({
      requestId,
      traceId: trace.traceId,
      spanId: trace.spanId,
    });

    c.set("requestContext", baseRequestContext);
    c.set("logger", baseLogger);
    c.header("x-request-id", requestId);
    c.header("traceparent", formatTraceParent(trace));

    if (principalResolver) {
      const authorization = c.req.header("authorization");
      const cookie = c.req.header("cookie");
      const principal = await principalResolver.resolve({
        ...(authorization === undefined ? {} : { authorization }),
        ...(cookie === undefined ? {} : { cookie }),
      });

      if (principal !== undefined) {
        c.set("requestContext", { ...baseRequestContext, principal });
        c.set(
          "logger",
          baseLogger.child({
            subject: principal.subject,
            ...(principal.tenantId === undefined ? {} : { tenantId: principal.tenantId }),
          }),
        );
      }
    }

    await next();
  });
}
