# Architecture

## Dependency direction

```text
HTTP / Hono / Zod contracts
          |
          v
Application services ---> core ports (Logger, HttpClient, tracing/context)
          |
          v
Domain repository ports
          ^
          |
Infrastructure adapters (Drizzle/PostgreSQL, fetch, JSON logger)
```

`core` contains stable application-owned abstractions and does not import Hono, Drizzle, or Zod. `contracts` owns API schemas. `infrastructure` implements adapters. `modules` are feature-first and keep domain/application code independent of HTTP.

## Cross-cutting context

`requestId` identifies one inbound API request. `traceId` follows the complete distributed trace. `spanId` identifies the local operation. Incoming W3C `traceparent` values retain the trace ID while the server creates a fresh local span ID.

## Validation

Validation exists at three boundaries:

1. Zod request/response contracts validate transport data.
2. Application/domain services enforce business rules.
3. PostgreSQL constraints remain authoritative for persistence invariants such as unique email addresses.

Database schemas and API schemas are deliberately separate.

## Testing

Service tests mock the repository port and may spy on logging. Repository tests run against real PostgreSQL and seed rows through factories. API tests use Hono's in-process request API so they test routing and validation without opening a TCP port.

## External HTTP

Application code should not call global `fetch` directly. `FetchHttpClient` fixes the upstream origin, rejects absolute URLs to reduce SSRF foot-guns, injects request/trace headers, applies a timeout, maps network/upstream failures into `AppError`, and validates JSON responses against a caller-provided schema.
