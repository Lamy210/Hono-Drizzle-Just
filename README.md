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
- Structured JSON logging behind an application-owned `Logger` interface with secret redaction.
- External HTTP access goes through an application-owned `HttpClient` abstraction and `FetchHttpClient` adapter.
- Environment variables are parsed once at startup into a typed configuration object.
- Deployment-safe liveness/readiness probes and graceful shutdown are built in.

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
just db-push
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
| `SERVICE_NAME` | `hono-drizzle-just` | Structured log service name |
| `PORT` | `3000` | HTTP listen port |
| `DATABASE_URL` | required | PostgreSQL connection URL |
| `DATABASE_POOL_MAX` | `10` | Maximum PostgreSQL pool size |
| `DATABASE_CONNECTION_TIMEOUT_MS` | `5000` | Pool connection timeout |
| `LOG_LEVEL` | `info` | Minimum structured log level |
| `HTTP_DEFAULT_TIMEOUT_MS` | `10000` | Default outbound HTTP timeout for adapters |
| `HEALTH_CHECK_TIMEOUT_MS` | `1500` | Critical dependency readiness deadline |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Grace period for in-flight HTTP requests |

Invalid configuration fails startup before database/service composition. Configuration errors list variable names and validation reasons without echoing secret values.

## Health and shutdown

`/health/live` only confirms that the process and HTTP stack are alive. It intentionally does not depend on PostgreSQL, so a database outage does not cause an orchestrator to restart an otherwise healthy process repeatedly.

`/health/ready` checks critical dependencies. The default PostgreSQL check executes `select 1`; failures and timeouts return `503` with a sanitized per-check status.

On `SIGINT` or `SIGTERM`, the server stops accepting new connections and waits for in-flight requests. If they exceed `SHUTDOWN_TIMEOUT_MS`, active connections are force-closed. Registered resources are then closed once in reverse registration order.

## Transactions

Application services that need atomic persistence depend on `TransactionManager<TUnitOfWork>`, not on Drizzle. A feature-owned unit-of-work interface lists only the repository ports that the use case can access. The production Drizzle adapter creates those repositories from the active transaction session.

The sample user creation flow performs the duplicate lookup and insert in the same transaction. Returning from the operation commits; throwing rolls back the complete unit of work. PostgreSQL constraints remain authoritative under concurrency, and repository adapters translate known database errors after unwrapping Drizzle's error cause chain.

Automatic transaction retries and implicit `AsyncLocalStorage` transactions are intentionally not enabled by default.

## Test factories

Factory infrastructure lives under `tests/factories` only. `TestFactory<T>` exposes `build/buildMany` for DB-free unit tests; `PersistentTestFactory<T,TCreated>` additionally exposes `create/createMany` through an explicit persistence callback.

`makeUserFactory()` returns a build-only user factory, while `makeUserFactory(databaseSession)` persists through the supplied root or transactional Drizzle session. Each factory instance owns its own sequence state, UUIDs are generated with `crypto.randomUUID()`, and default emails include a random suffix to avoid collisions between factory instances.

Relations stay explicit rather than being auto-created. Create the related record first, then pass its identifier as an override to the dependent factory. `createMany` preserves order but is not implicitly atomic; pass a transaction session when atomic fixture setup is required.

## Common commands

```bash
just check
just test
just test-integration
just test-all
just format
just db-generate
just db-push
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

## Request correlation and tracing

Every request receives an `x-request-id`. A valid incoming UUID request ID is accepted and normalized to lowercase; otherwise the server creates one. W3C `traceparent` is accepted only in its lowercase wire format and a new local span ID is generated for the request. The active `traceId` is attached to structured logs and common error responses.

## UUID policy

RFC UUID input is case-insensitive. `CanonicalUuidSchema` accepts a valid uppercase/lowercase UUID and normalizes it to lowercase. Trace IDs are different: W3C Trace Context requires lowercase hexadecimal identifiers, so uppercase trace IDs are rejected.

## Architecture

See [`docs/architecture.md`](docs/architecture.md).
