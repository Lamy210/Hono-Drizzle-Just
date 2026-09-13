import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
  LivenessResponseSchema,
  ReadinessResponseSchema,
} from "../../contracts/common/health";
import type { ReadinessChecker } from "../../core/health/readiness-checker";
import type { AppEnv } from "../env";

const livenessRoute = createRoute({
  method: "get",
  path: "/health/live",
  tags: ["System"],
  responses: {
    200: {
      description: "Process liveness",
      content: { "application/json": { schema: LivenessResponseSchema } },
    },
  },
});

const readinessRoute = createRoute({
  method: "get",
  path: "/health/ready",
  tags: ["System"],
  responses: {
    200: {
      description: "Service is ready for traffic",
      content: { "application/json": { schema: ReadinessResponseSchema } },
    },
    503: {
      description: "A critical dependency is unavailable",
      content: { "application/json": { schema: ReadinessResponseSchema } },
    },
  },
});

export function registerHealthRoutes(
  app: OpenAPIHono<AppEnv>,
  readinessChecker: ReadinessChecker,
): void {
  app.openapi(livenessRoute, (c) => {
    const response = LivenessResponseSchema.parse({ status: "ok" });
    return c.json(response, 200);
  });

  app.get("/health", (c) => {
    const response = LivenessResponseSchema.parse({ status: "ok" });
    return c.json(response, 200);
  });

  app.openapi(readinessRoute, async (c) => {
    const result = ReadinessResponseSchema.parse(await readinessChecker.check());
    if (result.status === "ready") {
      return c.json(result, 200);
    }
    c.get("logger").warn("health.readiness.not_ready", {
      downChecks: Object.entries(result.checks)
        .filter(([, check]) => check.status === "down")
        .map(([name]) => name),
    });
    return c.json(result, 503);
  });
}
