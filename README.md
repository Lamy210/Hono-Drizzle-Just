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
- Application-layer tenant authorization with scope-gated sample user operations and tenant-scoped persistence.
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

## Using this template

After creating a repository with GitHub **Use this template**, initialize the generated repository before starting feature work:

```bash
bun install
just init
just doctor
cp .env.example .env
just db-up
just ci
just dev
```

`just init` reads the GitHub `origin` and derives the generated repository identity. It updates only the active identity fields managed by this template: `package.json` package/repository metadata, the README opening identity block, `.env.example` `SERVICE_NAME`, the runtime `SERVICE_NAME` default and its configuration-test assertion. It then runs `bun install --lockfile-only` and verifies that the root workspace name in `bun.lock` matches the new package name.

The initializer does **not** perform repository-wide search-and-replace. Historical design documents, later README references, database names, fixtures, and unrelated strings are intentionally left alone.

### Preview or override the inferred identity

Preview the exact managed files without writing anything or regenerating the lockfile:

```bash
just init --dry-run
```

When the GitHub origin is unavailable or the inferred defaults are not appropriate, pass explicit values:

```bash
just init \
  --repository acme/example-api \
  --name "Example API" \
  --package-name example-api \
  --service-name example-api
```

The equivalent Bun command is:

```bash
bun run template:init -- --repository acme/example-api --name "Example API"
```

All flags are optional when the repository identity can be inferred safely. Explicit package and service names are validated rather than silently repaired.

Initialization is fail-closed. It proceeds only when every managed field is still in the pristine source-template state, or when every managed field already matches the requested identity. Re-running the same identity is a successful no-op. A partially customized repository, or attempting to change from one initialized identity to another, is rejected instead of guessing which values to overwrite. If lockfile regeneration or post-write verification fails, the initializer restores the captured managed files, including `bun.lock`.

### Doctor

`just doctor` is a non-mutating local consistency check. It does not contact a database or external network service. It verifies the Bun toolchain, package/lockfile identity, canonical GitHub package metadata, `SERVICE_NAME` consistency, README opening identity, source-template residue in active metadata, and the local Git origin when one is available.

Results are line-oriented `PASS`, `WARN`, or `FAIL` records. Internal contradictions such as a package/lockfile mismatch are `FAIL` and produce a non-zero exit status. A missing, non-GitHub, or different Git origin is only `WARN` because forks and mirrors can be intentional.

### Manual fallback

If you intentionally cannot use `just init`, make the same active identity changes manually and then run `just doctor`:

- Change `package.json#name`, `package.json#repository.url`, `package.json#bugs.url`, and `package.json#homepage`.
- Run `bun install --lockfile-only` so the `bun.lock` root workspace name follows `package.json#name`.
- Update only the first README heading and opening description for the project identity.
- Keep `.env.example` `SERVICE_NAME`, the default in `src/config/config.schema.ts`, and the matching assertion in `tests/unit/config/load-config.test.ts` synchronized.

Do not blindly replace every occurrence of `Hono-Drizzle-Just`, `hono-drizzle-just`, `app`, or `app_test`. Some occurrences are documentation, historical design records, test fixtures, or intentionally generic defaults.

### Optional database naming

The default local database name is `app`; renaming it is not required and `just init` deliberately does not change it. If you choose a project-specific database name, update the coordinated references rather than editing only one URL:

- `.env.example`
- `compose.yaml` (`POSTGRES_DB` and the health-check database)
- `drizzle.config.ts` fallback URL
- `justfile` fallback URLs
- `.github/workflows/ci.yml` integration/E2E `DATABASE_URL` values and PostgreSQL database names

The CI databases may use separate names such as `app_test` and `app_e2e`; keep local tooling, migration tooling, and CI consistent with the naming convention you choose.

Before the first production deployment, review every variable in `.env.example`, never commit local credentials or production secrets, and explicitly review `SERVICE_NAME`, `DATABASE_URL`, `LOG_LEVEL`, shutdown deadlines, and OpenTelemetry settings for the target environment.

## Dependency reproducibility

`bun.lock` is committed source-of-truth for the resolved dependency graph. Local development may use `bun install`; when a dependency is added, removed, or updated, commit the resulting `package.json` and `bun.lock` changes together in the same pull request.

`.bun-version` is the repository's exact Bun toolchain target and CI reads it directly. `package.json` keeps `engines.bun` as the compatibility floor for consumers, while CI verifies the installed Bun version exactly matches `.bun-version` before dependency installation.

GitHub Actions are executed from full immutable commit SHAs. The trailing major-version comments such as `# v7` and `# v2` are for human readability only; changing an Action version requires reviewing and committing the new SHA explicitly.

CI first requires the lockfile to exist and then installs with `bun ci`, so dependency metadata that is not reflected in `bun.lock` fails before lint, typecheck, tests, or migrations run. Do not delete or regenerate the lockfile opportunistically in unrelated changes.

Verification commands have five stable layers:

- `just check-fast` runs lint, typecheck, and unit/API tests without requiring PostgreSQL. Use it in the normal edit loop.
- `just check` adds committed Drizzle migration-history verification and is the same quality command used by GitHub Actions.
- `just coverage` runs the unit/API suite with Bun's native coverage gate, requiring at least 80% line coverage and 75% function coverage and producing `coverage/lcov.info`.
- `just test-e2e` launches the real production entrypoint twice with separate development/test bearer principals over the same migrated PostgreSQL database. It proves authenticated create/read, cross-tenant 404 isolation, tenant-local email uniqueness, readiness, and SIGTERM shutdown. Use `bun run ci:e2e` to apply committed migrations first and run the standalone E2E gate.
- `just ci` runs the quality checks, coverage gate, applies committed migrations once, runs the PostgreSQL integration suite, and then runs black-box E2E against the migrated database. With the same database environment, it is the local full-CI equivalent.

The service listens on `http://localhost:3000` by default.

- `GET /health` — compatibility liveness endpoint
- `GET /health/live` — process/HTTP liveness; does not query PostgreSQL
- `GET /health/ready` — readiness; returns 503 when a critical dependency is unavailable
- `POST /users` - protected; requires an authenticated tenant principal with `users:write`; optional `Idempotency-Key` enables tenant-scoped replay
- `GET /users/{id}` - protected; requires an authenticated tenant principal with `users:read`
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
| `HTTP_MAX_REQUEST_BODY_BYTES` | `1048576` | Application-level inbound request body limit; Hono returns the common 413 error contract when exceeded |
| `HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES` | `2097152` | Bun transport hard cap; must be greater than `HTTP_MAX_REQUEST_BODY_BYTES` |
| `HEALTH_CHECK_TIMEOUT_MS` | `1500` | Critical dependency readiness deadline |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period for in-flight HTTP requests |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry trace/metrics SDK and exporters |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base OTLP/HTTP collector endpoint; `/v1/traces` and `/v1/metrics` are appended |
| `OTEL_METRIC_EXPORT_INTERVAL_MS` | `60000` | Periodic metrics export interval |
| `AUTH_DEV_STATIC_ENABLED` | `false` | Enable the development/test-only static bearer `PrincipalResolver`; rejected when `NODE_ENV=production` |
| `AUTH_DEV_STATIC_BEARER_TOKEN` | empty | Static bearer credential; required at 32-512 bytes only when the development adapter is enabled |
| `AUTH_DEV_STATIC_SUBJECT` | empty | Server-configured principal subject for the development adapter |
| `AUTH_DEV_STATIC_TENANT_ID` | empty | Server-configured opaque tenant identifier; `__legacy__:` values are reserved |
| `AUTH_DEV_STATIC_SCOPES` | empty | Space-delimited server-configured scopes such as `users:read users:write` |

Invalid configuration fails startup before database/service composition. Configuration errors list variable names and validation reasons without echoing secret values. The OTLP endpoint accepts only HTTP(S) URLs without embedded credentials, query parameters, or fragments.

## Authentication and tenant authorization

`PrincipalResolver` remains the provider-neutral authentication port. The sample user module adds an application-layer authorization boundary on top of that identity: `POST /users` requires `users:write`, while `GET /users/{id}` requires `users:read`. Anonymous protected requests return `401`; an authenticated principal with a missing/invalid tenant or missing scope returns `403`; and a user that is absent from the authorized tenant, including a row owned by another tenant, returns `404` without an unscoped existence check.

Tenant ownership is derived only from `RequestContext.principal.tenantId`. Client payloads or ad-hoc tenant headers cannot select a tenant. `UserRepository` requires the tenant ID in its read methods, Drizzle includes the tenant predicate in SQL lookups, and user email uniqueness is enforced by PostgreSQL as `(tenant_id, email)`. The same normalized email may therefore exist in different tenants while remaining unique inside one tenant.

The built-in `StaticBearerPrincipalResolver` exists only to make local development, CI, and black-box E2E exercise the real authentication/authorization composition path. It is disabled by default, its credential and principal data come from `AUTH_DEV_STATIC_*` configuration, and startup rejects `AUTH_DEV_STATIC_ENABLED=true` when `NODE_ENV=production`. Deployed applications must compose a real identity-provider adapter that validates JWT/session/OIDC/Ory/Cognito or equivalent credentials and maps trusted identity data into `Principal`; do not promote the static resolver into a production authentication scheme.

Static bearer values are validated without echoing the credential into configuration errors, and raw `Authorization`, cookies, and bearer tokens are not copied into request context, structured logs, telemetry attributes, or client error responses. The reserved `__legacy__:` tenant prefix is used only by the migration backfill for rows that predate tenant ownership and cannot be selected by a normal authorized tenant principal.

## Idempotent user creation

`POST /users` accepts an optional `Idempotency-Key` header. When omitted, user creation keeps the ordinary tenant-local behavior. When present, the key is scoped to the authorized tenant: the same tenant/key with the same normalized `email` and `name` replays the original user with HTTP `201` and the same user ID, while reusing an active tenant/key for a different normalized payload returns HTTP `422` with `IDEMPOTENCY_KEY_REUSED`. The same raw key may be used independently by another tenant.

Clients should generate high-entropy unique keys such as UUIDs. The service hashes the raw key and canonical normalized request fingerprint with SHA-256 before persistence; raw keys, hashes, fingerprints, tenant IDs, prior payloads, and replay user IDs are not added to logs, telemetry attributes, or error payloads.

The PostgreSQL `user_creation_idempotency` ledger and user insert are owned by the same transaction. A successful claim has a 24-hour replay window measured with database time. Expired entries are reclaimed lazily when that tenant/key is used again; the template does not require Redis or a background cleanup worker. Expiry only permits the key to be treated as new again—it does not bypass ordinary tenant-local email uniqueness, so retrying an already-created email after expiry may return `409`.

## Inbound HTTP policy

Inbound request bodies use two independent safety boundaries. Hono enforces the application-visible limit (`HTTP_MAX_REQUEST_BODY_BYTES`, 1 MiB by default) after request correlation and request logging are established. Requests that cross this limit receive HTTP `413` with the common `REQUEST_BODY_TOO_LARGE` JSON envelope, including `requestId` and `traceId` when available.

Bun separately enforces `HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES` (2 MiB by default) as the process-level hard cap. This value must be strictly greater than the Hono limit so ordinary oversized requests can reach the application boundary and receive the structured error response. A payload that exceeds Bun's hard cap may be rejected before Hono runs, so that transport-level `413` is not guaranteed to use the application JSON error envelope or correlation fields.

The defaults target JSON APIs. Applications that intentionally accept large uploads should review global and route-specific limits rather than simply increasing both values. Multipart upload policy, decompressed-body limits, slow-request protection, rate limiting, and reverse-proxy/WAF limits are separate concerns.

## Health and shutdown

`/health/live` only confirms that the process and HTTP stack are alive. It intentionally does not depend on PostgreSQL, so a database outage does not cause an orchestrator to restart an otherwise healthy process repeatedly.

`/health/ready` checks critical dependencies. The default PostgreSQL check executes `select 1`; failures and timeouts return `503` with a sanitized per-check status.

On `SIGINT` or `SIGTERM`, the server stops accepting new connections and waits for in-flight requests. If they exceed `SHUTDOWN_TIMEOUT_MS`, active connections are force-closed. Registered resources are then closed once in reverse registration order. Production composition closes PostgreSQL before flushing/shutting down telemetry, so shutdown work can still be exported.

## Transactions

Application services that need atomic persistence depend on `TransactionManager<TUnitOfWork>`, not on Drizzle. A feature-owned unit-of-work interface lists only the repository ports that the use case can access. The production Drizzle adapter creates those repositories from the active transaction session.

The sample user creation flow performs the tenant-local duplicate lookup and tenant-owned insert in the same transaction. When an `Idempotency-Key` is supplied, ledger claim/replay, user creation, and ledger completion use that same transaction, so a failed create cannot leave a committed incomplete claim. Returning from the operation commits; throwing rolls back the complete unit of work. PostgreSQL constraints remain authoritative under concurrency, and repository adapters translate known database errors after unwrapping Drizzle's error cause chain.

Automatic transaction retries and implicit `AsyncLocalStorage` transactions are intentionally not enabled by default.

## Database migrations

The TypeScript schema under `src/db/schema` is the authoring model, while committed files under `drizzle/` are the deployable database history. After changing the schema, run `just db-generate`, review the generated SQL and metadata, and commit all resulting migration files together.

Use `just db-migrate` to apply committed migrations. CI starts DB-backed jobs with empty PostgreSQL databases and applies the committed history before the integration or E2E suite runs. The quality job runs `bun run check`, which includes `just db-verify` semantics (`drizzle-kit check`, `drizzle-kit generate`, then a clean-diff check), so a schema change without a committed migration fails before merge.

`just db-push` remains available only as a local-development convenience for disposable databases. It is not used by CI or deployment workflows. The API process also does not run migrations during startup; schema deployment is a separate operational step.

If a pre-existing database was previously managed with `drizzle-kit push`, do not blindly apply the initial migration to it. Establish an explicit baseline/repair procedure for that database first so its existing schema and Drizzle migration log are reconciled safely.

The tenant-ownership migration preserves the committed initial migration, adds `users.tenant_id` as `varchar(128) NOT NULL`, backfills pre-tenant rows with reserved `__legacy__:<user-id>` identifiers, removes global email uniqueness, and replaces it with `UNIQUE(tenant_id, email)`. Reserved legacy tenant IDs are intentionally inaccessible through the normal authorization boundary.

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

Configured `baseUrl` values must use HTTP or HTTPS and must not contain embedded username/password credentials. Each physical fetch attempt uses `redirect: "manual"`, so redirects are surfaced as upstream failures instead of being followed automatically to another origin. Redirect support, if required by an application, should be added as an explicit allowlisted policy rather than by relying on the platform fetch default.

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
just init --dry-run
just init
just doctor
just check-fast
just check
just coverage
just ci
just test
just test-integration
just test-e2e
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
| Black-box E2E | Real PostgreSQL | No | Production entrypoint, TCP/readiness, persisted critical flow, and graceful shutdown |

Repository integration tests use persistent factories to insert actual rows. This intentionally avoids mocking Drizzle or PostgreSQL. The same factory defaults can be used through build-only factories in database-free tests.

The black-box E2E suite intentionally remains small. It launches `bun run start`, waits for `/health/ready`, checks liveness/readiness, creates and fetches one user over real HTTP, then sends SIGTERM and requires a clean process exit. Detailed negative HTTP cases stay in API tests and persistence details stay in integration tests.

### Coverage

`just coverage` (equivalent to `bun run test:coverage`) runs the unit and API suites with Bun's native coverage collector. `bunfig.toml` enforces minimum aggregate coverage of **80% lines** and **75% functions**, excludes test files from the calculation, emits a text summary, and writes LCOV output to `coverage/lcov.info`. The generated `coverage/` directory is gitignored; CI verifies that the LCOV file is non-empty but does not require Codecov, Coveralls, or another external coverage service.

Bun reports coverage for source files that are loaded by the selected test run. A source module that is never imported can be absent from the report, so the aggregate percentage is a regression gate for measured code and is **not** proof that every source file in the repository was included. Use the coverage report together with test design and integration/E2E coverage rather than optimizing only for the percentage.

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