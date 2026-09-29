import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { httpRouteLabel } from "../route-label";

export const requestLoggerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const startedAt = performance.now();
  await next();
  c.get("logger").info("http.request", {
    method: c.req.method,
    route: httpRouteLabel(c),
    statusCode: c.res.status,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  });
});
