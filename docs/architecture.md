# Architecture

## Dependency direction

```text
HTTP / Hono / Zod contracts
          |
          v
Application services ---> core ports (Logger, HttpClient, health, lifecycle, tracing/context)
          |
          v
Domain repository ports
          ^
          |
Infrastructure adapters (Drizzle/PostgreSQL, fetch, health probes, JSON logger)
```

`core` contains stable application-owned abstractions and does not import Hono, Drizzle, Zod, or PostgreSQL. `contracts` owns API schemas. `infrastructure` implements adapters. `modules` are feature-first and keep domain/application code independent of HTTP.

## Composition and configuration

Environment variables are read only at startup and parsed by `loadConfig()` into `AppConfig`. The composition root receives typed config and constructs infrastructure adapters. Feature code must not read `process.env` or `Bun.env` directly.

This keeps configuration failures deterministic and makes composition testable without mutating process-global environment state.

## Cross-cutting context

`requestId` identifies one inbound API request. `traceId` follows the complete distributed trace. `spanId` identifies the local operation. Incoming W3C `traceparent` values retain the trace ID while the server creates a fresh local span ID.

## Validation

Validation exists at three boundaries:

1. Zod request/response contracts validate transport data.
2. Application/domain services enforce business rules.
3. PostgreSQL constraints remain authoritative for persistence invariants such as unique email addresses.

Database schemas and API schemas are deliberately separate.

## Health model

Liveness and readiness have different failure domains:

- `/health/live` proves the process can serve HTTP and has no external dependency checks.
- `/health/ready` runs critical `HealthCheck` implementations. The default production composition includes PostgreSQL.
- A readiness check exception is converted into `down`; internal exception messages are not returned to clients.
- `/health` remains a compatibility liveness alias.

A dependency outage can therefore remove the instance from traffic without causing an unnecessary process restart loop.

## Lifecycle and shutdown

`ApplicationLifecycle` owns shutdown callbacks and executes them once in reverse registration order. It continues closing later resources if one close fails and reports an aggregate error afterward.

`GracefulShutdownCoordinator` uses Bun server semantics rather than closing infrastructure immediately:

1. Stop accepting new requests with `server.stop(false)`.
2. Allow in-flight requests to complete up to the configured grace period.
3. Force active connections closed with `server.stop(true)` if the deadline is exceeded.
4. Close database and future application resources through `ApplicationLifecycle`.

The coordinator does not call `process.exit`; only the executable entry point controls process exit behavior.

## Testing

Service tests mock the repository port and may spy on logging. Repository tests run against real PostgreSQL and seed rows through factories. API tests use Hono's in-process request API so they test routing and validation without opening a TCP port.

Health tests explicitly verify that liveness remains successful during dependency failure and readiness returns a controlled 503. Lifecycle tests verify reverse shutdown order, idempotence, and forced connection termination after the deadline.

## External HTTP

Application code should not call global `fetch` directly. `FetchHttpClient` fixes the upstream origin, rejects absolute URLs to reduce SSRF foot-guns, injects request/trace headers, applies a timeout, maps network/upstream failures into `AppError`, and validates JSON responses against a caller-provided schema.
