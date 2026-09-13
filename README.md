# Hono-Drizzle-Just

Reusable backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.

## Goals

- Feature-first modules with explicit application/domain/infrastructure/presentation boundaries.
- Repository integration tests use a real PostgreSQL database populated by factories.
- Service unit tests use Bun's built-in `mock()` / `spyOn()` and never require a database.
- Request and response contracts are defined with Zod and exposed through OpenAPI.
- UUID input accepts upper/lowercase RFC UUIDs; application-facing canonical values are lowercase.
- W3C `traceparent` propagation with separate request IDs, trace IDs, and span IDs.
- Structured JSON logging behind an application-owned `Logger` interface with secret redaction.
- External HTTP access goes through an application-owned `HttpClient` abstraction and `FetchHttpClient` adapter.

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

- `GET /health`
- `POST /users`
- `GET /users/{id}`
- `GET /openapi.json`

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
| Service | No | Repository mock, collaborator spies | Use-case behavior |
| Repository integration | Real PostgreSQL | No | Drizzle queries and constraints |
| API | No by default | Repository behind real services | HTTP validation/contracts |

Repository integration tests use `tests/factories` to insert actual rows. This intentionally avoids mocking Drizzle or PostgreSQL.

## Request correlation and tracing

Every request receives an `x-request-id`. A valid incoming UUID request ID is accepted and normalized to lowercase; otherwise the server creates one. W3C `traceparent` is accepted only in its lowercase wire format and a new local span ID is generated for the request. The active `traceId` is attached to structured logs and common error responses.

## UUID policy

RFC UUID input is case-insensitive. `CanonicalUuidSchema` accepts a valid uppercase/lowercase UUID and normalizes it to lowercase. Trace IDs are different: W3C Trace Context requires lowercase hexadecimal identifiers, so uppercase trace IDs are rejected.

## Architecture

See [`docs/architecture.md`](docs/architecture.md).
