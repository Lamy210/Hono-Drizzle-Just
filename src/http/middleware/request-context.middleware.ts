import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { PrincipalResolver } from "../../core/auth/principal-resolver";
import type { RequestContext } from "../../core/context/request-context";
import { AppError } from "../../core/errors/app-error";
import type { Logger } from "../../core/logging/logger";
import type { Meter } from "../../core/observability/meter";
import { NoopMeter } from "../../core/observability/noop-meter";
import { NoopTracer } from "../../core/observability/noop-tracer";
import type { Tracer } from "../../core/observability/tracer";
import { CanonicalUuidSchema } from "../../contracts/common/primitives";
import {
  createRequestTrace,
  formatTraceParent,
  parseTraceParent,
} from "../../infrastructure/tracing/w3c-trace-context";
import type { AppEnv } from "../env";
import type { RemoteAddressResolver } from "../remote-address";

export interface RequestObservability {
  readonly tracer: Tracer;
  readonly meter: Meter;
}

function metricRoute(c: Parameters<typeof routePath>[0]): string {
  return routePath(c, -1) || "unmatched";
}

export function createRequestContextMiddleware(
  rootLogger: Logger,
  principalResolver?: PrincipalResolver,
  observability: RequestObservability = {
    tracer: new NoopTracer(),
    meter: new NoopMeter(),
  },
  remoteAddressResolver?: RemoteAddressResolver,
) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const startedAt = performance.now();
    const incomingTraceParent = c.req.header("traceparent") ?? null;
    const incomingTraceState = c.req.header("tracestate");
    const parsedParent = parseTraceParent(incomingTraceParent);
    const parent = parsedParent
      ? {
          ...parsedParent,
          ...(incomingTraceState === undefined ? {} : { traceState: incomingTraceState }),
        }
      : undefined;
    const fallbackTrace = createRequestTrace(incomingTraceParent, incomingTraceState);

    await observability.tracer.withSpan(
      "http.server.request",
      {
        kind: "server",
        attributes: { "http.request.method": c.req.method },
        ...(parent === undefined ? {} : { parent, parentIsRemote: true }),
      },
      async (span) => {
        const trace = span.traceContext() ?? fallbackTrace;
        const incomingRequestId = CanonicalUuidSchema.safeParse(c.req.header("x-request-id"));
        const requestId = incomingRequestId.success
          ? incomingRequestId.data
          : crypto.randomUUID().toLowerCase();
        const baseRequestContext: RequestContext = {
          requestId,
          trace,
          startedAt,
        };
        const baseLogger = rootLogger.child({
          requestId,
          traceId: trace.traceId,
          spanId: trace.spanId,
        });

        let requestContext = baseRequestContext;
        c.set("requestContext", requestContext);
        c.set("logger", baseLogger);
        c.header("x-request-id", requestId);
        c.header("traceparent", formatTraceParent(trace));

        try {
          const remoteAddress = remoteAddressResolver?.(c);
          if (remoteAddress !== undefined) {
            requestContext = { ...requestContext, remoteAddress };
            c.set("requestContext", requestContext);
          }

          if (principalResolver) {
            const authorization = c.req.header("authorization");
            const cookie = c.req.header("cookie");
            const principal = await principalResolver.resolve({
              ...(authorization === undefined ? {} : { authorization }),
              ...(cookie === undefined ? {} : { cookie }),
            });

            if (principal !== undefined) {
              requestContext = { ...requestContext, principal };
              c.set("requestContext", requestContext);
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
          const route = metricRoute(c);
          const statusCode = c.res.status;
          const attributes = { method: c.req.method, route, status_code: statusCode } as const;
          span.setAttribute("http.route", route);
          span.setAttribute("http.response.status_code", statusCode);
          if (statusCode >= 500) {
            span.setStatus("error");
          }
          observability.meter.increment("http.server.requests", 1, attributes);
          observability.meter.record(
            "http.server.duration",
            (performance.now() - startedAt) / 1_000,
            attributes,
          );
        } catch (error) {
          const route = metricRoute(c);
          const statusCode = error instanceof AppError ? error.status : 500;
          const attributes = { method: c.req.method, route, status_code: statusCode } as const;
          span.setAttribute("http.route", route);
          span.setAttribute("http.response.status_code", statusCode);
          span.setStatus("error");
          observability.meter.increment("http.server.requests", 1, attributes);
          observability.meter.record(
            "http.server.duration",
            (performance.now() - startedAt) / 1_000,
            attributes,
          );
          throw error;
        }
      },
    );
  });
}
