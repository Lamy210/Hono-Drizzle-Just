# Hono-Drizzle-Just

Reusable backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.

## Goals

- Feature-first modules with explicit application/domain/infrastructure/presentation boundaries.
- Repository integration tests use a real PostgreSQL database populated by typed test factories.
- Service unit tests use Bun's built-in `mock()` / `spyOn()` and never require a database.
- Explicit transaction boundaries use an application-owned `TransactionManager` instead of leaking Drizzle transaction types into services.
- Request and response contracts are defined with Zod and exposed through OpenAPI.
- UUID input accepts upper/lowercase RFC UUIDs; application-facing canonical values are lowercase.
- W3C `traceparent` propagation with separate request IDs, trace IDs, and span IDs.
- Provider-neutral `Principal` / `PrincipalResolver` authentication context without coupling services to Hono or a specific identity provider.
- Vendor-neutral `Tracer` / `Meter` ports with optional OpenTelemetry trace and metrics export.
- Structured JSON logging behind an application-owned `Logger` interface with secret redaction.
- External HTTP access goes through an application-owned `HttpClient` abstraction and `FetchHttpClient` adapter.
- Outbound HTTP retries are conservative, idempotency-aware, deadline-bounded, and trace-preserving.
- Environment variables are parsed once at startup into a typed configuration object.
- Deployment-safe liveness/readiness probes and graceful shutdown are built in.
- Database changes are delivered as committed Drizzle migrations rather than runtime schema pushes.

## Requirements

- Bun 1.4.2+
- PostgreSQL 18 (the application itself can target another supported PostgreSQL release)
- `just` for the documented task shortcuts
- Docker/Compose for the default local database workflow

## Quick start

```bash
cp .env.example .env
bun install
just db-up
just db-migrate
just dev
```

The service listens on `http://localhost:3000` by default.

- `GET /health` — compatibility liveness endpoint
- `GET /health/live` — process/HTTP liveness; does not query PostgreSQL
- `GET /health/ready` — readiness; returns 503 when a critical dependency is unavailable
- `POST /users`
- `GET /users/{id}`
- `GET /openapi.json`

## Configuration

Configuration is loaded once during startup. Application modules should not read `process.env` or `Bun.env` directly.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `SERVICE_NAME` | `hono-drizzle-just` | Structured log and telemetry service name |
| `PORT` | `3000` | HTTP listen port |
| `DATABASE_URL` | required | PostgreSQL connection URL |
| `DATABASE_POOL_MAX` | `10` | Maximum PostgreSQL pool size |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Pool connection timeout |
| `LOG_LEVEL` | `info` | Minimum structured log level |
| `HTTP_DEFAULT_TIMEOUT_MS` | `10000` | Total outbound HTTP deadline across attempts and retry delays |
| `HTTP_DEFAULT_ATTEMPT_TIMEOUT_MS` | `3000` | Maximum duration of one outbound fetch attempt |
| `HEALTH_CHECK_TIMEOUT_MS` | `1500` | Critical dependency readiness deadline |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period for in-flight HTTP requests |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry trace/metrics SDK and exporters |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base OTLP/HTTP collector endpoint; `/v1/traces` and `/v1/metrics` are appended |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | `60000` | Periodic metrics export interval |

Invalid configuration fails startup before database/service composition. Configuration errors list variable names and validation reasons without echoing secret values. The OTLP endpoint accepts only HTTP(S) URLs without embedded credentials, query parameters, or fragments.

## Health and shutdown

`/health/live` only confirms that the process and HTTP stack are alive. It intentionally does not depend on PostgreSQL, so a database outage does not cause an orchestrator to restart an otherwise healthy process repeatedly.

`/health/ready` checks critical dependencies. The default PostgreSQL check executes `select 1`; failures and timeouts return `503` with a sanitized per-check status.

On `SIGINT` or `SIGTERM`, the server stops accepting new connections and waits for in-flight requests. If they exceed `SHUTDOWN_TIMEOUT_MS`, active connections are force-closed. Registered resources are then closed once in reverse registration order. Production composition closes PostgreSQL before flushing/shutting down telemetry, so shutdown work can still be exported.

## Transactions

Application services that need atomic persistence depend on `TransactionManager<TUnitOfWork>`, not on Drizzle. A feature-owned unit-of-work interface lists only the repository ports that the use case can access. The production Drizzle adapter creates those repositories from the active transaction session.

The sample user creation flow performs the duplicate lookup and insert in the same transaction. Returning from the operation commits; throwing rolls back the complete unit of work. PostgreSQL constraints remain authoritative under concurrency, and repository adapters translate known database errors after unwrapping Drizzle's error cause chain.

Automatic transaction retries and implicit `AsyncLocalStorage` transactions are intentionally not enabled by default.

## Database migrations

The TypeScript schema under `src/db/schema` is the authoring model, while committed files under `drizzle/` are the deployable database history. After changing the schema, run `just db-generate`, review the generated SQL and metadata, and commit all resulting migration files together.

Use `just db-migrate` to apply committed migrations. CI starts with an empty PostgreSQL database, applies the committed history, and only then runs integration tests. The quality job runs `just db-verify` semantics (`drizzle-kit check`, `drizzle-kit generate`, then a clean-diff check) so a schema change without a committed migration fails before merge.

`just db-push` remains available only as a local-development convenience for disposable databases. It is not used by CI or deployment workflows. The API process also does not run migrations during startup; schema deployment is a separate operational step.

If a pre-existing database was previously managed with `drizzle-kit push`, do not blindly apply the initial migration to it. Establish an explicit baseline/repair procedure for that database first so its existing schema and Drizzle migration log are reconciled safely.

## Test factories

Factory infrastructure lives under `tests/factories` only. `TestFactory<T>` exposes `build/buildMany` for DB-free unit tests; `PersistentTestFactory<T,TCreated>` additionally exposes `create/createMany` through an explicit persistence callback.

`makeUserFactory()` returns a build-only user factory, while `makeUserFactory(databaseSession)` persists through the supplied root or transactional Drizzle session. Each factory instance owns its own sequence state, UUIDs are generated with `crypto.randomUUID()`, and default emails include a random suffix to avoid collisions between factory instances.

Relations stay explicit rather than being auto-created. Create the related record first, then pass its identifier as an override to the dependent factory. `createMany` preserves order but is not implicitly atomic; pass a transaction session when atomic fixture setup is required.

## Observability

Application code depends on the small `Tracer` and `Meter` ports under `core/observability`, not on OpenTelemetry SDK types. `NoopTracer` and `NoopMeter` are the default behavior when `OTEL_ENABLED=false`; disabled telemetry does not construct exporters or make collector requests.

When enabled, the infrastructure runtime uses OpenTelemetry traces and metrics with an `AsyncLocalStorage` context manager. The runtime exports OTLP/HTTP traces to `<endpoint>/v1/traces` and metrics to `<endpoint>/v1/metrics`, attaches `service.name` and `deployment.environment.name` resource attributes, and flushes both providers during graceful shutdown. The enabled runtime, parent/child propagation, metrics export, shutdown, and same-process reinitialization are exercised by the Bun CI test suite.

Inbound requests create one `http.server.request` server span. A valid remote W3C parent is preserved while a new local span ID becomes the `RequestContext.trace` identity, structured-log correlation identity, and outgoing `traceparent`. Server metrics use the registered Hono route pattern (for example `/users/:id`) rather than the raw URL, avoiding UUID/user-input cardinality.

`FetchHttpClient` creates one `http.client.request` client span per logical outbound request, not per retry attempt. The child span context is propagated consistently across every retry. Client metrics use method, upstream host, outcome, and optional status code; raw request paths are deliberately excluded from labels.

Database repositories use an explicit `DatabaseObserver` around actual Drizzle query execution. Query spans and `db.client.operation.duration` use only low-cardinality attributes such as `db.system.name=postgresql`, `db.operation.name`, and a known collection/table name. SQL text, bind parameters, UUIDs, email addresses, names, and other request data are deliberately excluded from trace and metric attributes.

Transaction boundaries are measured separately as `db.transaction` spans and `db.transaction.duration`. The transaction measurement covers the complete Drizzle transaction callback, while individual repository queries remain child operations when OpenTelemetry context propagation is enabled. Commit sets the transaction span to `ok`; rollback/error sets it to `error` while preserving the original application/database exception.

PostgreSQL pool size/idle/waiting metrics are intentionally not represented yet. The current application-owned `Meter` exposes counters and histograms only; pool state requires observable gauge semantics and will be added only when that contract is introduced rather than approximated with the wrong metric type.

The built-in JSON logger remains the logging path. Trace and span IDs correlate those logs with telemetry without making the application logger depend on the OpenTelemetry Logs SDK.

## Outbound HTTP policy

Application code should depend on `HttpClient` instead of calling global `fetch` directly. `FetchHttpClient` fixes the upstream origin, rejects absolute caller-provided URLs, propagates request/trace correlation headers, validates successful JSON responses, and maps transport failures into stable application errors.

`timeoutMs` is a **total request deadline** covering all network attempts and retry delays. `attemptTimeoutMs` limits one fetch attempt and is always capped by the remaining total deadline. Adapter defaults are 10 seconds total and 3 seconds per attempt; composition should normally supply the typed configuration values above.

Retry behavior is deliberately conservative:

- `GET`, `HEAD`, and `OPTIONS` may retry automatically.
- `POST`, `PUT`, `PATCH`, and `DELETE` do not retry automatically; set `retry: "idempotent"` only when the caller can guarantee replay safety.
- Set `retry: "never"` to disable retry even for a normally retryable read request.
- The default policy allows one retry for network/attempt-timeout failures and HTTP `408`, `429`, `502`, `503`, or `504`.
- `Retry-After` is honored in both delay-seconds and HTTP-date forms.
- Without `Retry-After`, retry delay uses capped exponential backoff with full jitter.
- A retry is skipped when its delay cannot fit inside the remaining total deadline.
- JSON decoding and response-schema validation failures are never retried.
- `x-request-id`, `traceparent`, and `tracestate` remain stable across attempts for the same outbound request.

Retry eligibility and delay calculation live in `RetryPolicy`, so an application can replace the default policy without changing service code or the `HttpClient` port.

## Common commands

```bash
just check
just test
just test-integration
just test-all
just format
just db-generate
just db-check
just db-verify
just db-migrate
just db-push     # local/disposable DB only
just db-reset
```

## Testing policy

| Layer | Database | Mock/spy | Purpose |
| --- | --- | --- | --- |
| Unit / domain | No | Only when useful | Pure behavior |
| Service | No | Transaction manager/repository mocks, collaborator spies | Use-case behavior |
| Repository integration | Real PostgreSQL | No | Drizzle queries, constraints, and error mapping |
| Transaction integration | Real PostgreSQL | No | Commit/rollback semantics |
| API | No by default | Repository behind real services | HTTP validation/contracts |

Repository integration tests use persistent factories to insert actual rows. This intentionally avoids mocking Drizzle or PostgreSQL. The same factory defaults can be used through build-only factories in database-free tests.

## Authentication context

Authentication is adapter-driven. `core/auth` defines a provider-neutral `Principal` with `subject` plus optional `tenantId`, `roles`, and `scopes`, and a `PrincipalResolver` port that maps inbound credentials into that normalized shape. JWT/OIDC claims, Ory sessions, Cognito payloads, or other provider-specific structures must be translated at the adapter boundary rather than exposed to services.

`createApp` accepts an optional `PrincipalResolver`. If none is configured, requests remain anonymous and `RequestContext.principal` is absent. When a resolver is configured, the HTTP middleware passes only the inbound `Authorization` and `Cookie` credential values to it. Raw credentials are not copied into `RequestContext`, structured log context, or error responses.

Base request correlation is established before principal resolution. A resolver can therefore throw a stable `AppError` such as `UNAUTHORIZED`/401 without losing `requestId`, `traceId`, or the request logger. Once resolution succeeds, only the normalized `subject` and optional `tenantId` are added to log context.

Authentication and authorization remain separate concerns. This template does not force a JWT library, identity provider, role model, or route authorization policy; protected routes/use cases should explicitly require a principal or specific scopes/roles when such policy is added.

## Request correlation and tracing

Every request receives an `x-request-id`. A valid incoming UUID request ID is accepted and normalized to lowercase; otherwise the server creates one. W3C `traceparent` is accepted only in its lowercase wire format. With OpenTelemetry enabled, the server span's trace/span IDs become the canonical request trace context; with telemetry disabled, the built-in W3C trace-context adapter preserves the same correlation behavior. The active `traceId` is attached to structured logs and common error responses.

## UUID policy

RFC UUID input is case-insensitive. `CanonicalUuidSchema` accepts a valid uppercase/lowercase UUID and normalizes it to lowercase. Trace IDs are different: W3C Trace Context requires lowercase hexadecimal identifiers, so uppercase trace IDs are rejected.

## Architecture

See [`docs/architecture.md`](docs/architecture.md).
