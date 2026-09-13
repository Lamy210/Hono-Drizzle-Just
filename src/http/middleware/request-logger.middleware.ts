import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

export const requestLoggerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const startedAt = performance.now();
  await next();
  c.get("logger").info("http.request", {
    method: c.req.method,
    path: c.req.path,
    statusCode: c.res.status,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  });
});
