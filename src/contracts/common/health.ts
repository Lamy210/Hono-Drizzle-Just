import { z } from "@hono/zod-openapi";

export const LivenessResponseSchema = z
  .object({ status: z.literal("ok") })
  .openapi("LivenessResponse");

export const HealthCheckOutcomeSchema = z.object({
  status: z.enum(["up", "down"]),
  durationMs: z.number().nonnegative(),
});

export const ReadinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z.record(z.string(), HealthCheckOutcomeSchema),
  })
  .openapi("ReadinessResponse");
