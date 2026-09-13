# Config, Lifecycle, and Health Design

## Goal

Make the template fail fast on invalid configuration, expose deployment-safe liveness/readiness probes, and shut down gracefully without closing shared resources while requests are still in flight.

## Scope

- Parse environment variables once at startup into a typed `AppConfig`.
- Remove direct `process.env` access from composition and server setup.
- Add `/health/live` and `/health/ready` while keeping `/health` as a liveness-compatible alias.
- Add a reusable health-check port plus PostgreSQL readiness check.
- Add an application lifecycle registry for closeable resources.
- Add a graceful shutdown coordinator around Bun's server stop semantics.

## Configuration

`loadConfig()` accepts an environment-like record and returns camelCase configuration. Unknown environment variables are ignored. Secret values are never included in validation error messages.

Required:
- `DATABASE_URL`: `postgres:` or `postgresql:` URL.

Defaults:
- `NODE_ENV=development`
- `SERVICE_NAME=hono-drizzle-just`
- `PORT=3000`
- `LOG_LEVEL=info`
- `HTTP_DEFAULT_TIMEOUT_MS=10000`
- `DATABASE_POOL_MAX=10`
- `DATABASE_CONNECTION_TIMEOUT_MS=5000`
- `HEALTH_CHECK_TIMEOUT_MS=1500`
- `SHUTDOWN_TIMEOUT_MS=10000`

Numeric configuration must be finite integers in a documented safe range.

## Health semantics

- `/health/live`: proves the process and HTTP stack are alive. It does not query PostgreSQL or external dependencies.
- `/health/ready`: checks critical dependencies and returns `200 { status: "ready" }` only when all checks are up. It returns `503 { status: "not_ready" }` if any check fails.
- `/health`: compatibility alias for liveness.
- Individual readiness check exceptions are converted to `down`; they do not turn the endpoint into an unhandled 500.
- Health responses are defined as Zod contracts and runtime-validated before being returned.

## Lifecycle

`ApplicationLifecycle` owns close callbacks. It closes them once, in reverse registration order. If one close fails, remaining resources still close and an aggregate error is reported.

The graceful shutdown coordinator is independent from `process.exit` for testability:
1. Receive SIGINT/SIGTERM from `server.ts`.
2. Call `server.stop(false)` so new connections stop while in-flight requests may finish.
3. Wait up to `SHUTDOWN_TIMEOUT_MS`.
4. If the deadline expires, log a warning and call `server.stop(true)` to force active connections closed.
5. Close registered application resources.
6. `server.ts` chooses the final process exit code.

## Database

`createDatabase()` receives typed pool options rather than reading environment variables. The PostgreSQL health adapter depends only on a query-capable pool shape and applies the configured readiness timeout.

## Testing

- Config: defaults, coercion, invalid ports, invalid database schemes, and redacted configuration failures.
- Readiness: all-up, one-down, and thrown-check behavior.
- API: liveness remains healthy when readiness is down; readiness emits 200/503 correctly.
- Lifecycle: reverse close ordering, idempotence, error continuation, graceful stop ordering, and forced stop after timeout.

## Non-goals

- OpenTelemetry exporter lifecycle (later PR).
- Transaction management (next PR).
- Kubernetes-specific manifests.
- Circuit breakers or rate limiting.
