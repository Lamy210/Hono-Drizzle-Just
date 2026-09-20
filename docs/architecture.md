# Architecture

## Dependency direction

```text
HTTP / Hono / Zod contracts
          |
          v
Application services ---> core ports (Logger, HttpClient, TransactionManager, PrincipalResolver, RateLimiter, Tracer, Meter, health, lifecycle, tracing/context)
          |
          v
Domain repository ports
          ^
          |
Infrastructure adapters (Drizzle/PostgreSQL, transactions, fetch, health probes, JSON logger, OpenTelemetry, identity-provider adapters)
```

`core` contains stable application-owned abstractions and does not import Hono, Drizzle, Zod, PostgreSQL, or OpenTelemetry SDK types. `contracts` owns API schemas. `infrastructure` implements adapters. `modules` are feature-first and keep domain/application code independent of HTTP.

## Composition and configuration

Environment variables are read only at startup and parsed by `loadConfig()` into `AppConfig`. The composition root receives typed config and constructs infrastructure adapters. Feature code must not read `process.env` or `Bun.env` directly.

This keeps configuration failures deterministic and makes composition testable without mutating process-global environment state. Outbound HTTP composition receives separate total-deadline and per-attempt timeout defaults so adding retries cannot silently multiply the caller's latency budget.

OpenTelemetry is opt-in. `OTEL_ENABLED=false` composes the application-owned Noop tracer and meter without constructing exporters. When enabled, the composition root creates one telemetry runtime for the process and registers its shutdown callback with the application lifecycle.

## Dependency reproducibility

`package.json` declares the intended direct dependency versions, while committed `bun.lock` is the resolved dependency graph used by automation. Dependency changes must update both artifacts together so reviewers can inspect the requested version change and the resulting transitive graph in one pull request.

`.bun-version` is the exact repository toolchain target used by CI, while `package.json#engines.bun` remains the consumer compatibility floor. The workflow reads `.bun-version` through `setup-bun` and then verifies `bun --version` exactly matches it before installing dependencies.

Third-party GitHub Actions are referenced by full commit SHA to make workflow execution immutable. A trailing major-version comment documents the human-readable release line, but updating an Action requires an explicit reviewed SHA change rather than following a mutable tag automatically.

CI treats the lockfile as required input rather than generated output. Both quality and integration jobs verify `bun.lock` exists and then use `bun ci`; linting, type checking, tests, migrations, and database integration therefore run against the committed dependency resolution. Local development may use `bun install` to update the lockfile intentionally.

## Database schema and migrations

`src/db/schema` is the code-first authoring model. `drizzle/` is the committed deployment history: SQL migrations, the migration journal, and snapshots travel together in source control.

The lifecycle is intentionally split by responsibility:

1. Developers change the TypeScript schema and run `drizzle-kit generate`.
2. Review verifies both the schema change and generated migration artifacts.
3. CI runs `drizzle-kit check`, regenerates from the committed snapshot, and requires `drizzle/` to remain unchanged.
4. Integration starts from an empty PostgreSQL database and runs `drizzle-kit migrate` before tests.
5. Deployment applies the same committed migration history as a separate step before or alongside application rollout.

`drizzle-kit push` is not part of CI or deployment. It is retained only for disposable local-development databases. Application startup never calls `push`, `generate`, or `migrate`, so API availability and schema deployment are not coupled.

The initial migration establishes the current template schema from an empty database. A database that already has equivalent tables because it was previously managed with `push` must be baselined explicitly; applying the initial migration blindly would conflict with existing objects. Baseline/repair automation is outside the default template because it depends on the state and ownership of the target database.

Tenant ownership is introduced by a later migration rather than by rewriting the baseline. It adds `users.tenant_id`, backfills existing rows to reserved `__legacy__:<user-id>` identifiers before making the column `NOT NULL`, drops global email uniqueness, and adds `UNIQUE(tenant_id, email)`. Normal tenant validation rejects the reserved legacy prefix, so migrated historical rows cannot accidentally become visible to an ordinary tenant principal.

User-create idempotency is introduced by a subsequent forward migration, again without rewriting earlier history. `user_creation_idempotency` is keyed by `(tenant_id, key_hash)`, stores the SHA-256 request fingerprint and the completed `user_id`, and uses database timestamps for expiry. The user reference is completed inside the same transaction as the user insert, while expired claims are reclaimed lazily on reuse rather than by a required background worker.

Rate-limit persistence is introduced by a later forward migration. `rate_limit_buckets` is keyed by `(scope, identity_hash)`, stores only the hashed identity plus the active fixed-window timestamps/count, and reuses the same row when a window expires.


## Transactions and unit of work

The application-owned transaction abstraction is generic:

```text
TransactionManager<TUnitOfWork>
  run(operation: (unitOfWork: TUnitOfWork) => Promise<TResult>)
```

Each feature defines the narrow unit of work needed by its use cases. For the sample user module, `UserUnitOfWork` exposes the tenant-scoped `UserRepository` and the feature-scoped `UserCreationIdempotencyRepository`; it contains no Drizzle types.

`DrizzleTransactionManager` is an infrastructure adapter. It starts `db.transaction()`, passes the active transaction session to a composition-supplied factory, and invokes the application operation with the resulting unit of work. `DatabaseSession` is a structural subset shared by the root Drizzle database and a transaction session, so repository implementations do not need separate transactional variants.

Returning from the operation commits. Throwing propagates the error and causes Drizzle/PostgreSQL to roll back the transaction. Nested savepoints, serialization/deadlock retries, and implicit AsyncLocalStorage transaction state are intentionally outside the default template.

PostgreSQL constraints remain authoritative. Drizzle wraps driver errors in `DrizzleQueryError`, so repository adapters inspect the error `cause` chain when mapping stable PostgreSQL error codes such as `23505` into application errors.

The idempotent create path hashes the raw key before entering persistence, claims `(tenant_id, key_hash)` in PostgreSQL, and relies on the primary-key conflict wait to serialize concurrent first use of the same tenant/key. A matching completed claim replays the user through the tenant-scoped `findById`; a different fingerprint fails with `422`. Claim, duplicate-email check, user insert, and claim completion all share one transaction, so rollback removes a failed fresh claim together with the failed create.


## Cross-cutting context

`requestId` identifies one inbound API request. `traceId` follows the complete distributed trace. `spanId` identifies the local operation. Incoming W3C `traceparent` values retain the trace ID while the server creates a fresh local span ID.

`RequestContext` also carries an optional normalized `Principal`. This keeps identity available to application services without exposing Hono request objects or identity-provider-specific session/JWT structures. Protected application services authorize against that principal, derive tenant ownership from it, and pass the authorized tenant ID into tenant-scoped repository methods rather than accepting tenant selection from client payloads or transport headers.

In the Bun production entrypoint, `RequestContext.remoteAddress` is populated from Hono's Bun `getConnInfo()` adapter, which delegates to `server.requestIP(request)` and therefore represents the direct transport peer rather than a caller-controlled HTTP header. `RequestContext.clientAddress` is the effective client identity after the configured trusted-proxy policy runs; without a trusted proxy it is the canonical direct peer. In-process application/OpenAPI tests do not require a Bun server and may leave both fields absent. Neither address is added to structured logs or telemetry by default because network addresses can be sensitive and high-cardinality.

## Inbound HTTP safety boundary

Inbound body size is enforced at two layers with intentionally different responsibilities. Hono owns the application-visible boundary through its built-in `bodyLimit()` middleware. Bun owns the final transport/process boundary through `Bun.serve({ maxRequestBodySize })`.

The middleware order is deliberate:

```text
request context / tracing
  -> request logger
    -> body limit
      -> route validation / handler
```

The default Hono limit is 1 MiB (`HTTP_MAX_REQUEST_BODY_BYTES=1048576`). Because request context and logging execute first, an application-level overflow is mapped through the common error handler as `REQUEST_BODY_TOO_LARGE` / HTTP 413 and retains request/trace correlation. The limit is enforced before route validation and application services, so oversized bodies do not reach use-case or persistence code.

The default Bun hard cap is 2 MiB (`HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES=2097152`). Startup configuration requires this value to be strictly greater than the Hono limit. This ordering gives the application boundary room to return its structured error for normal oversized requests while still protecting the process from substantially larger bodies. A request rejected by Bun can fail before Hono creates correlation state, so transport-level 413 responses are not promised to use the common JSON envelope.

The global defaults are intended for ordinary JSON APIs. Multipart uploads, per-route limit overrides, decompressed-body accounting, slow-request protection, rate limiting, and reverse-proxy/WAF limits remain separate policies rather than being folded into this boundary.

`HTTP_TRUSTED_PROXY_CIDRS` is empty by default, so forwarding headers cannot affect client identity. When CIDRs are configured, only `X-Forwarded-For` is interpreted, and only when the direct `remoteAddress` belongs to a trusted range. The resolver walks the forwarded chain from right to left, skips trusted proxy hops, and selects the first untrusted hop as `clientAddress`. This defeats a client-prepended spoofed address when a trusted proxy appends the real source. If the header is malformed, too long, contains too many hops, or the direct peer is not trusted, resolution falls back to the canonical direct peer. `Forwarded`, `CF-Connecting-IP`, and `X-Real-IP` remain ignored to avoid ambiguous multi-header precedence. Security controls such as future rate limiting should key on `clientAddress`, while audit/debug logic can retain `remoteAddress` as the transport peer.

## Rate limiting boundary

`core/rate-limit/RateLimiter` owns only the consumption contract: a stable scope, a normalized identity, and an allow/deny decision with retry delay. It does not import Hono and does not select Redis, PostgreSQL, an edge provider, or an in-memory algorithm.

The HTTP middleware runs after request context and the request logger but before routing/body validation. It keys each request with `RequestContext.clientAddress`, so trusted-proxy parsing stays outside the limiter. A bounded policy resolver maps `POST /users` to `http.users.write`, single-resource `GET /users/{id}` to `http.users.read`, and other non-health traffic to `http.global`. This mapping is based on method plus route shape; the concrete user ID never becomes part of the rate-limit scope. A denial returns the common correlated `RATE_LIMITED` / 429 envelope directly and sets `Retry-After`; it is therefore recorded as an ordinary client response rather than an internal exception. Invalid limiter metadata or adapter failures still flow through the common 500 error path.

Liveness/readiness paths bypass rate limiting to avoid turning abuse-control state into orchestration health failures. When no client network identity exists, the middleware skips consumption; this preserves in-process/OpenAPI generation and makes non-network transports compose explicitly.

Production composition provides PostgreSQL fixed-window and GCRA adapters but keeps rate limiting disabled by default. `HTTP_RATE_LIMIT_ALGORITHM` selects the adapter while reusing the same bounded scope policies. Enabling `HTTP_RATE_LIMIT_ENABLED` composes that adapter against the same PostgreSQL database used by the application, so replicas sharing the database also share rate-limit state. The adapter accepts one default fixed-window policy plus bounded scope-specific overrides. Unknown/future scopes fall back to the default policy; current production composition supplies explicit read/write overrides for the sample users API. The adapter keeps one row per `(scope, identity_hash)`; an atomic PostgreSQL upsert increments the active bucket or resets the same row after expiry. This avoids per-window row growth and avoids the split-counter behavior of a process-local Map.

The adapter hashes `scope + NUL + identity` with SHA-256 before persistence. Raw client addresses are not stored in `rate_limit_buckets`, added to database-observability attributes, or copied into error responses. Expired rows are periodically deleted on the hot path, bounded to at most one cleanup attempt per process every 60 to 300 seconds depending on window length and at most 1,000 rows per attempt. Cleanup selects the oldest expired keys under `FOR UPDATE SKIP LOCKED` and deletes them in the same SQL statement, so concurrent replicas can make progress without all blocking on one batch. An `(expires_at, scope, identity_hash)` btree index supports the expiry scan and deterministic cleanup order. The rate-limit decision itself uses the database row as the shared authority.

The GCRA adapter stores one theoretical-arrival timestamp per `(scope, identity_hash)` in a separate table. A missing identity is inserted atomically; subsequent requests use a conditional PostgreSQL `UPDATE` whose eligibility predicate is evaluated while PostgreSQL serializes conflicting row updates. This means concurrent requests share one authoritative schedule without a process-local mutex. The configured `limit/windowSeconds` pair defines the emission interval, and burst tolerance permits up to `limit` immediate requests from a fully restored state. A denied request does not advance the theoretical-arrival timestamp.

GCRA state expires once the theoretical-arrival timestamp has passed, because the full burst capacity is then restored. Cleanup uses the same bounded 1,000-row, indexed, skip-locked strategy as fixed-window state. Keeping `rate_limit_gcra_buckets` separate from `rate_limit_buckets` makes algorithm changes reversible and prevents one algorithm from reinterpreting the other's persisted state.

A policy change applies a new request limit immediately to the current counter. A changed window duration takes full effect when that scope/identity bucket next resets, because an active bucket retains its database expiry until rollover. This avoids rewriting active buckets during configuration rollout and keeps the database row authoritative.

Rate limiting is fail-closed in the selected PostgreSQL adapter: storage failures propagate through the common HTTP 500 path instead of treating the request as allowed. This is a deliberate security/availability choice. Applications that need fail-open behavior, lower-latency Redis counters, token buckets, sliding windows, or provider-edge enforcement can still replace the application-owned `RateLimiter` port without changing request identity resolution or the HTTP 429 contract.

`RateLimitDecision` can carry optional quota metadata without requiring every backend to expose it. The PostgreSQL adapter reports the bounded policy ID, configured quota/window, non-negative remaining quota, and delay-seconds until the authoritative database bucket expires. The HTTP middleware validates every metadata field before serializing it, including a restricted policy identifier grammar, so an alternate/misbehaving adapter cannot inject response fields. On completed allowed requests it emits the provisional `RateLimit-Policy` and `RateLimit` fields; on direct 429 responses it emits those fields plus standards-based `Retry-After`.

The field serialization follows `draft-ietf-httpapi-ratelimit-headers-11` as of May 2026: policy items use `q` and `w`, while current service-limit items use `r` and `t`. The draft is not yet an RFC and its syntax may change before publication, so this compatibility surface is documented as provisional rather than presented as a stable HTTP standard. The template deliberately does not emit the older `X-RateLimit-*` family or obsolete early-draft `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` fields.

Rate-limit observability is a separate `RateLimitObserver` rather than a concern embedded in the HTTP middleware or database observer. It emits one decision counter and one decision-duration histogram per consume attempt, including failures. The only attributes are the finite adapter backend, algorithm, and result dimensions. Scope, client address, persisted identity hash, tenant data, retry delay, and exception details are intentionally excluded to prevent PII leakage and unbounded metric cardinality.

## Observability boundary

`core/observability` owns small `Tracer`, `Span`, and `Meter` contracts. Application code can create spans and measurements without importing `@opentelemetry/*`. Noop implementations preserve exactly the same application behavior when telemetry is disabled.

The OpenTelemetry implementation lives entirely under `infrastructure/observability`. It composes a trace provider, metrics provider, OTLP/HTTP exporters, resource attributes, and an `AsyncLocalStorage` context manager. The context manager is process-global by OpenTelemetry API design, so an enabled production process must create one telemetry runtime at a time. Shutdown calls `context.disable()` after provider flush/shutdown so a later same-process initialization, such as a development/test restart, can register a fresh manager safely.

Inbound HTTP instrumentation creates one server span for the logical request. A valid incoming W3C parent is represented as a remote parent; the local span identity becomes the canonical `RequestContext.trace`, structured-log correlation identity, and response `traceparent`. HTTP metrics label the registered Hono route pattern rather than raw URLs, so identifiers and arbitrary path input do not create unbounded cardinality.

HTTP server span status follows the server-side HTTP error boundary: handled 4xx responses keep span status unset, while 5xx responses and unexpected exceptions mark the span as `error`. Structured error handling uses the same distinction operationally. Handled 4xx `AppError` responses emit `warn` / `http.request.rejected` with bounded classification fields and omit the raw Error object/stack; 5xx or unknown exceptions emit `error` / `http.request.error` with diagnostic exception data. HTTP request counters and duration histograms retain the actual status code in both cases.

Outbound `FetchHttpClient` instrumentation creates one client span for the complete logical request, including retries. All attempts reuse that child trace context and the same request ID. Client metric attributes are limited to method, configured upstream host, outcome, and optional status code; raw request paths are not metric labels.

Database instrumentation is explicit rather than hidden in Drizzle or `pg` global auto-instrumentation. `DatabaseObserver` lives in infrastructure and depends only on the application-owned `Tracer` / `Meter` ports. Repository adapters wrap the actual awaited query execution, so the measured duration covers the database operation rather than unrelated request/service work.

Rate-limit instrumentation follows the same explicit observer pattern. `RateLimitObserver` wraps the complete limiter decision, so `rate_limit.decision.duration` includes cleanup plus the authoritative PostgreSQL fixed-window upsert or GCRA state transition. `rate_limit.decisions` distinguishes allowed, denied, and error outcomes without using request-derived values as labels.

Database query attributes are deliberately bounded to semantic operation metadata: `db.system.name=postgresql`, `db.operation.name`, and a known `db.collection.name` where available. SQL statements, bind values, UUIDs, email addresses, names, and other request/domain values are excluded to avoid secret/PII leakage and unbounded cardinality. Query duration is recorded as `db.client.operation.duration` in seconds.

Transactions are a separate boundary. `DrizzleTransactionManager` optionally wraps its complete transaction callback with `DatabaseObserver.transaction()`, producing a `db.transaction` span and `db.transaction.duration`. Repository operations executed through the transaction session use the same observer, so with OpenTelemetry enabled they become child database-operation spans. Commit marks the transaction span `ok`; rollback/error marks it `error`, records duration in a `finally` path, and rethrows the original error.

`createDatabaseAccess()` is the production composition helper that gives the root repository, transaction manager, and transaction-scoped repositories the same `DatabaseObserver`. This avoids accidentally losing query instrumentation when code crosses from root database access into a transaction.

`ObservableMeter` extends the synchronous `Meter` port with callback-based observable up/down counters while leaving ordinary application/test meters source-compatible. `DatabasePoolObserver` maps the node-postgres pool snapshot into the current OpenTelemetry database pool metric model: `db.client.connection.count` emits separate `idle` and `used` measurements, `db.client.connection.max` reports the configured pool ceiling, and `db.client.connection.pending_requests` reports `waitingCount`. Every series carries only the bounded `db.client.connection.pool.name=primary` attribute plus the finite connection-state attribute where required. The observer is registered in production composition and unregistered during lifecycle shutdown before telemetry is finally flushed/shut down.

The JSON logger remains an application-owned logging path. OpenTelemetry Logs are not required by the template; trace/span IDs provide correlation between structured logs and exported traces.

## Authentication boundary

`core/auth` owns two provider-neutral contracts:

```text
Principal
  subject
  tenantId?
  roles[]?
  scopes[]?

PrincipalResolver
  resolve({ authorization?, cookie? }) -> Principal | undefined
```

`PrincipalResolver` is a port, not a JWT/OIDC/Ory implementation. A concrete authentication adapter validates its provider-specific credentials/session and maps successful identity data into `Principal`. Services can therefore reason about authenticated subject/tenant/roles/scopes without importing provider SDK types.

The request-context middleware establishes `requestId`, trace context, and a base request logger **before** invoking the resolver. This ordering is deliberate: an invalid credential or unavailable identity provider may throw an `AppError`, and the common error handler still needs correlation context and a logger to return a controlled response. `UNAUTHORIZED` is a stable 401 application error code for authentication adapters to use when appropriate.

Raw `Authorization` and `Cookie` values are passed only to the resolver. They are not stored in `RequestContext`, copied into logger context, or echoed in error responses. After successful resolution, only `subject` and optional `tenantId` are added to structured log context.

If no resolver is composed, the request remains anonymous. The template still does not choose a JWT package, OIDC provider, Ory/Cognito integration, or role hierarchy. Authentication answers "who is this?"; application authorization answers "may this principal perform this use case for this tenant?"

The sample user module demonstrates that second boundary with `requireTenantScope()`: creation requires `users:write`, lookup requires `users:read`, missing authentication maps to 401, and missing/invalid tenant or scope maps to a sanitized 403. Cross-tenant lookup is a tenant-scoped repository miss and therefore returns the same 404 as an unknown ID; the service never performs an unscoped existence probe.

`UserRepository` encodes isolation structurally. `findById(tenantId, id)` and `findByEmail(tenantId, email)` require tenant context in their signatures, and the Drizzle adapter combines the tenant predicate with the resource predicate. Creation persists the tenant ID derived from the authorized principal. PostgreSQL enforces `(tenant_id, email)` uniqueness so concurrency cannot bypass the service-level duplicate check.

`StaticBearerPrincipalResolver` is a development/test adapter wired by typed `AUTH_DEV_STATIC_*` configuration. It is disabled by default and startup rejects it in `NODE_ENV=production`. It exists so local/CI/E2E execution can exercise the normal composition boundary without selecting a production identity provider. Real deployments replace that adapter with a credential-validating provider integration; raw bearer/cookie values remain confined to the resolver boundary and are never added to request context or telemetry.

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
4. Close registered infrastructure resources through `ApplicationLifecycle`.

Production composition registers telemetry, pool-observability cleanup, and PostgreSQL in that order. Reverse shutdown therefore closes PostgreSQL first, unregisters pool callbacks next, and flushes/shuts down telemetry last.

The coordinator does not call `process.exit`; only the executable entry point controls process exit behavior.

## Testing and factories

Service tests mock the transaction manager/repository ports and may spy on logging. Repository tests run against real PostgreSQL. Transaction integration tests use real PostgreSQL to prove commit and rollback. API tests use Hono's in-process request API so they test routing and validation without opening a TCP port.

All reusable fixture builders live under `tests/factories`; production code must not import them. The generic `TestFactory` has no persistence capability and is suitable for unit tests. `PersistentTestFactory` adds caller-supplied persistence and is used by feature factories such as `makeUserFactory(databaseSession)`.

Factory sequences are instance-local. Defaults generate valid UUIDs rather than UUID-shaped placeholders. Relations are explicit composition so factory calls do not hide additional database writes. Bulk persistence is sequential and deliberately non-atomic; tests can pass a transaction `DatabaseSession` when atomic setup matters.

Health tests explicitly verify that liveness remains successful during dependency failure and readiness returns a controlled 503. Lifecycle tests verify reverse shutdown order, idempotence, and forced connection termination after the deadline.

Authentication-context API tests verify anonymous requests, credential delivery to the resolver, normalized principal propagation, secret-free structured logging, application composition wiring, and correlation-preserving resolver failures. Authorization tests additionally cover 401/403 scope semantics, tenant-derived creation, cross-tenant 404 behavior, tenant-scoped repository SQL, tenant-local uniqueness, static bearer safety, and sequential tenant A/B black-box processes over one PostgreSQL database.

Observability tests verify Noop behavior, OpenTelemetry adapter mapping, Bun `AsyncLocalStorage` parent/child propagation, in-memory span export, metrics export, inbound route-cardinality control, outbound retry correlation, database operation/transaction measurement, graceful shutdown, and same-process telemetry reinitialization. Database observability integration tests run against real PostgreSQL and assert that identifiers/domain values are not copied into telemetry attributes.

## Inbound HTTP security headers

Every route is wrapped by Hono's built-in `secureHeaders()` middleware through a repository-owned API policy. The default keeps broadly safe response headers such as `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, legacy browser hardening headers, and `X-Powered-By` removal.

The template intentionally disables `Strict-Transport-Security`, `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy`, and `Origin-Agent-Cluster` in the application baseline. HSTS depends on the real HTTPS termination and domain ownership model, while cross-origin isolation/resource policy can break legitimate browser API consumers. Configure those policies explicitly at the application or edge once the deployment topology is known.

CORS remains unset by default. A generated service must define its own allowed origins, credentials policy, methods, and headers rather than inheriting a permissive wildcard policy from the template.

Routing failures are normalized at the HTTP boundary. An unmatched path returns the common correlated `NOT_FOUND` / 404 envelope, while a path that exists but does not support the requested method returns `METHOD_NOT_ALLOWED` / 405 with the standards-compatible `Allow` header. These responses are produced after request context is established, so request/trace IDs, structured request logging, metrics, and security headers remain consistent with application errors.

## External HTTP

Application code must not call global `fetch` directly. The application-owned `HttpClient` port expresses the request, total deadline, optional per-attempt timeout, retry intent, request context, and response schema without exposing Bun's fetch implementation.

`FetchHttpClient` is the infrastructure adapter. It fixes the upstream origin, rejects absolute caller-provided URLs to reduce SSRF foot-guns, injects correlation/tracing headers, serializes JSON request bodies, validates successful JSON responses, and maps transport/upstream failures into `AppError`.

The adapter treats its configured upstream as a trust boundary. `baseUrl` must use `http:` or `https:` and cannot contain embedded username/password credentials. Every underlying fetch attempt sets `redirect: "manual"`; a 3xx response is therefore handled as an upstream failure rather than automatically following `Location` to another origin. Supporting redirects later requires an explicit policy with host/scheme constraints rather than reverting to the platform default.

### Retry boundary

Retry eligibility and delay calculation live in `RetryPolicy`, not in services. The default policy is intentionally conservative:

- `GET`, `HEAD`, and `OPTIONS` are retryable by default.
- Other methods require `retry: "idempotent"`; this is an explicit assertion by the caller that replay is safe.
- `retry: "never"` disables retry even for safe methods.
- Retryable statuses are `408`, `429`, `502`, `503`, and `504`.
- Network failures and per-attempt timeout failures use the same retry budget.
- Successful responses that fail JSON decoding or schema validation are not retried.
- The default retry budget is one retry. A different `RetryPolicy` can change this without changing the `HttpClient` interface.

`Retry-After` is parsed as either delay-seconds or an HTTP-date. Without that header, `DefaultRetryPolicy` uses capped exponential backoff with full jitter. `Retry-After` is not clipped to the backoff cap; the caller's total deadline decides whether there is enough time to honor it.

### Deadline boundary

`timeoutMs` is a total monotonic deadline covering attempts and retry waits. `attemptTimeoutMs` limits one fetch operation. Before every attempt, the adapter calculates the remaining total budget and uses:

```text
actualAttemptTimeout = min(attemptTimeout, remainingTotalDeadline)
```

A retry is skipped when its delay cannot fit inside the remaining budget. This prevents `N` retries from turning a 10-second caller deadline into `N × 10` seconds. The default adapter values are 10 seconds total and 3 seconds per attempt.

The same precomputed request headers are reused across attempts, so `x-request-id`, `traceparent`, and `tracestate` remain stable for one logical outbound call. Attempt count may be added to logs/metrics without changing correlation identity.