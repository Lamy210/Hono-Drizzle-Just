# Tenant-scoped authorization boundary design

**Date:** 2026-09-16  
**Status:** approved design direction; written spec pending final review  
**Scope:** authorization, tenant isolation, sample `/users` protection, persistence boundaries, and production-path verification

## Context

The repository already has a provider-neutral authentication context. `Principal` carries `subject` plus optional `tenantId`, `roles`, and `scopes`; `PrincipalResolver` converts inbound credentials into that normalized shape; and the request-context middleware stores only the normalized principal in `RequestContext`.

That is authentication context, not authorization. The current sample user routes do not require a principal, `GetUserService` does not receive `RequestContext`, repository methods can query users without a tenant identifier, and the `users` table has no tenant column. The next platform boundary must make tenant isolation and authorization mandatory by construction rather than a route-level convention.

## Goals

1. Protect the sample `/users` API with application-owned authorization.
2. Use scopes rather than identity-provider roles as the application permission contract.
3. Require a tenant for every user read and write.
4. Prevent cross-tenant data access at the repository query boundary.
5. Make email uniqueness tenant-local rather than global.
6. Preserve provider neutrality: application code must not know JWT, OIDC, session, or vendor-specific claims.
7. Keep tenant IDs opaque strings so external organization identifiers do not require UUID remapping.
8. Preserve the real-process E2E test by supplying an explicitly enabled development/test resolver through the normal production composition root.
9. Make authorization behavior visible in API tests, integration tests, E2E tests, and OpenAPI responses.

## Non-goals

- Building a full IAM product, policy engine, or RBAC administration UI.
- Adding a `tenants` master table in this change.
- Implementing user-to-tenant membership persistence.
- Mapping vendor roles to scopes inside application services.
- Supporting row-level security in PostgreSQL in this change.
- Exposing tenant IDs in request bodies or trusting client-provided tenant identifiers.
- Introducing a concrete external IdP SDK.
- Shipping the static development resolver as an acceptable internet-facing production authentication mechanism.
- Defining a provider-specific OpenAPI security scheme before a concrete production authentication provider is selected.

## Chosen authorization model

The application permission vocabulary is scope-based:

- `users:read` permits `GET /users/{id}` within the current tenant.
- `users:write` permits `POST /users` within the current tenant.

`roles` remain available on `Principal` for adapters or future policy translation, but user services do not make decisions from roles directly.

Authorization is enforced in the application boundary, not only HTTP middleware. Route handlers pass `RequestContext` to application services. Services derive an authorized tenant access context before invoking repositories. This keeps internal service invocation subject to the same policy and avoids a transport-only security boundary.

## Core authorization API

Add a small provider-neutral authorization module under `src/core/auth`.

The primary helper is conceptually:

```ts
interface TenantAuthorization {
  readonly subject: string;
  readonly tenantId: string;
}

requireTenantScope(context: RequestContext, requiredScope: string): TenantAuthorization
```

Behavior:

1. `context.principal` absent -> `AppError("UNAUTHORIZED", ..., 401)`.
2. principal present but `tenantId` absent -> `AppError("FORBIDDEN", ..., 403)`.
3. tenant ID invalid for the application persistence contract -> 403.
4. required scope absent -> 403.
5. otherwise return the normalized subject and tenant ID.

The helper does not inspect raw headers or tokens.

### Tenant ID contract

Tenant IDs are opaque normalized strings owned by the resolver boundary, not UUIDs.

Persistence contract:

- length 1..128
- no leading or trailing whitespace
- no NUL/control characters
- value is otherwise opaque and case-sensitive

The authorization helper validates these invariants before a tenant ID can reach a repository. The resolver remains responsible for mapping an IdP-specific organization identifier into this normalized value.

The prefix `__legacy__:` is reserved for migration-only values and is rejected for request principals. This allows existing pre-tenant sample rows to be retained safely without making them accessible to a normal authenticated tenant.

## HTTP status semantics

The sample API uses the following distinction:

- **401 Unauthorized**: no authenticated principal is available, or supplied authentication credentials are invalid.
- **403 Forbidden**: a principal exists but lacks a usable tenant context or required scope.
- **404 Not Found**: the requested user does not exist *within the caller's tenant*.

A user ID belonging to another tenant returns the same 404 as an unknown ID. The service must never perform an unscoped lookup merely to distinguish those cases because doing so would disclose cross-tenant object existence.

Add `FORBIDDEN` to `AppErrorCode` and add HTTP status `403` to the supported status union.

## User domain and service changes

`User` becomes tenant-owned internally and carries `tenantId` in the domain model. `UserResponseSchema` does not expose `tenantId` by default; the tenant is an authorization boundary, not client-selected payload data.

`CreateUserRequestSchema` remains unchanged: clients submit only user attributes such as email and name. The service injects the tenant ID obtained from `RequestContext`.

`CreateUserService.execute(input, context)`:

1. require `users:write` and a valid tenant;
2. normalize email/name as today;
3. call `findByEmail(tenantId, normalizedEmail)`;
4. create with the authorized tenant ID;
5. retain existing request/trace-aware logging without logging scopes or credential material.

`GetUserService.execute(id, context)`:

1. require `users:read` and a valid tenant;
2. call `findById(tenantId, canonicalId)`;
3. return 404 when no tenant-scoped row is found.

## Repository boundary

Remove unscoped user lookup signatures. The repository contract becomes tenant-explicit, for example:

```ts
findById(tenantId: string, id: string): Promise<User | null>
findByEmail(tenantId: string, email: string): Promise<User | null>
create(input: TenantScopedCreateUserInput): Promise<User>
```

Every SQL query must include tenant criteria. `findById` uses `tenant_id = ? AND id = ?`; `findByEmail` uses `tenant_id = ? AND email = ?`; inserts always provide `tenant_id` from the authorized service context.

There is intentionally no convenience method such as `findById(id)` left on the interface. This makes accidental cross-tenant reads a type-level/API-design error.

## Database schema and migration

Add `tenant_id varchar(128) NOT NULL` to `users`.

Replace the global email uniqueness constraint with:

```text
UNIQUE (tenant_id, email)
```

This allows the same normalized email in separate tenants while preserving uniqueness inside one tenant.

### Existing-row migration

The repository already has a committed baseline migration, so the tenant change is a new migration rather than rewriting `0000_initial.sql`.

To preserve existing sample/development rows without assigning them to a real tenant:

1. add `tenant_id` temporarily nullable;
2. backfill each existing row to a unique reserved value: `__legacy__:<user-id>`;
3. set `tenant_id` NOT NULL;
4. drop the global email unique constraint;
5. add the composite `(tenant_id, email)` unique constraint.

Normal request principals cannot use the reserved `__legacy__:` prefix, so migrated legacy rows are retained but inaccessible through the protected tenant API until an operator deliberately reassigns them.

No `tenants` table or foreign key is introduced in this phase.

## Development/test static bearer resolver

Protecting `/users` makes the current production composition root incomplete for the existing real-process E2E test because no concrete `PrincipalResolver` is wired today. The template therefore adds a small **opt-in development/test static bearer resolver** that reuses the existing `PrincipalResolutionInput.authorization` boundary.

This resolver exists to keep the template runnable and test the full authorization path. It is not a production IdP implementation.

### Configuration

Add configuration equivalent to:

```text
AUTH_DEV_STATIC_ENABLED=false
AUTH_DEV_STATIC_BEARER_TOKEN=
AUTH_DEV_STATIC_SUBJECT=
AUTH_DEV_STATIC_TENANT_ID=
AUTH_DEV_STATIC_SCOPES=
```

Rules:

- `AUTH_DEV_STATIC_ENABLED` defaults to `false`.
- enabling it when `NODE_ENV=production` is a configuration error.
- when enabled, bearer token, subject, tenant ID, and scopes are all required.
- bearer token length: 32..512 bytes.
- subject length: 1..200 characters with no control characters.
- tenant ID must satisfy the tenant ID contract above.
- scopes are space-delimited, deduplicated, at most 32 entries, each 1..100 characters, matching `[A-Za-z0-9][A-Za-z0-9:._-]*`.
- serialized scope configuration is capped at 2048 characters.

The token remains a secret configuration value and must never be emitted in startup logs, validation errors, structured logs, telemetry, or responses.

### Resolver behavior

When the static resolver is enabled:

- no `Authorization` header -> `undefined` principal; protected services subsequently return 401.
- malformed non-Bearer authorization -> 401.
- wrong bearer token -> 401.
- correct bearer token -> return the server-configured subject, tenant ID, and scopes.

Token comparison uses a constant-time comparison after length normalization/checking rather than ordinary string equality.

The authenticated tenant and scopes come only from server configuration. A caller cannot select a tenant or scope by changing request payload/query values.

When the static resolver is disabled, production composition supplies no resolver, preserving the existing provider-neutral extension point. A real application replaces or extends the composition root with an OIDC/JWT/session resolver.

## OpenAPI behavior

`POST /users` documents 401 and 403 responses in addition to its existing responses.

`GET /users/{id}` documents 401 and 403 in addition to 404.

The generated OpenAPI snapshot is regenerated through the existing contract workflow. The change intentionally does not add a bearer-only security scheme because the production authentication mechanism remains an application choice; the static bearer adapter is explicitly a development/test utility and must not define the public production authentication contract.

## E2E behavior

The black-box E2E test continues to launch the real `bun run start` production entrypoint.

The E2E scenario uses one migrated PostgreSQL database and two **sequential** real server processes; they are not run concurrently.

Server A runs with `NODE_ENV=test`, static bearer auth enabled, and server-configured identity:

- deterministic strong bearer token A;
- subject `e2e-user-a`;
- tenant `tenant-e2e-a`;
- scopes `users:read users:write`.

The test first verifies a protected user request without `Authorization` returns 401. It then authenticates as tenant A, creates a user, fetches it successfully, records its ID/email, sends SIGTERM, and requires the same clean graceful-shutdown assertions as the existing E2E test.

Server B then starts against the **same database** with a different dynamic port and server-configured identity:

- deterministic strong bearer token B;
- subject `e2e-user-b`;
- tenant `tenant-e2e-b`;
- scopes `users:read users:write`.

The test authenticates as tenant B and proves:

1. `GET /users/{tenant-A-user-id}` returns 404;
2. `POST /users` with tenant A's normalized email returns 201;
3. tenant B can fetch its own newly created user;
4. server B also terminates cleanly through SIGTERM.

Detailed scope-denial permutations stay in API/unit tests rather than bloating the production E2E suite.

## Testing strategy

### Unit tests

Authorization helper tests cover:

- anonymous -> 401;
- missing tenant -> 403;
- malformed/reserved tenant -> 403;
- missing scope -> 403;
- required scope -> authorized tenant context.

Static bearer resolver/config tests cover:

- disabled mode;
- production-mode rejection;
- missing/malformed configuration;
- absent Authorization header;
- malformed bearer header;
- wrong token;
- correct token mapping;
- tenant/scope bounds;
- no token leakage.

Service tests verify the repository is always called with the authorized tenant ID.

### API tests

Protect the real `/users` routes and verify:

- anonymous 401;
- authenticated wrong/missing scope 403;
- authorized create/read success;
- cross-tenant GET returns 404;
- tenant ID supplied in unrelated client payload/header positions cannot override the principal tenant.

Existing principal-context tests remain provider-neutral and may continue to use injected mock resolvers.

### Integration tests

Real PostgreSQL tests verify:

- same email may exist in different tenants;
- duplicate email within one tenant conflicts;
- `findById` and `findByEmail` cannot see another tenant's row;
- migration applies from the committed baseline;
- migrated legacy rows receive reserved tenant IDs and remain structurally valid.

### Contract and E2E gates

OpenAPI snapshot/Redocly/oasdiff remain required. Existing quality, coverage, integration, E2E, contract, and aggregate required jobs remain mandatory.

## Observability and security

Authorization failures must not include the required scope list, another tenant ID, credential values, or row-existence details in client responses.

Database observability continues to use low-cardinality operation/collection attributes; tenant IDs are not added as metric/span attributes.

Structured logs may retain normalized subject and tenant ID as already designed, but raw `Authorization`, cookie, or bearer token values are never logged.

The static resolver's enablement and non-secret mode may be documented, but the configured token itself must never be interpolated into errors or diagnostics.

## Alternatives considered

### Route-only middleware authorization

Rejected because internal callers or later transports could bypass HTTP middleware, and repository access would remain unscoped by type.

### Role-based application checks

Rejected as the primary policy vocabulary because IdP roles are provider/business-organization specific. Scopes give the template a smaller provider-neutral application contract.

### UUID-only tenant IDs

Rejected because many IdPs provide opaque organization identifiers. Requiring UUIDs would force mapping infrastructure before it is needed.

### New `tenants` table now

Deferred. A master tenant model is appropriate once membership, lifecycle, billing, or tenant metadata is needed, but it is not required to prove isolation of the sample resource.

### Trusted reverse-proxy identity headers

Deferred. They are a valid production deployment pattern, but the current `PrincipalResolver` port intentionally receives Authorization/Cookie credentials only. Adding proxy identity headers would widen that authentication interface and require a separate trusted-network/header-stripping threat model. The static bearer test adapter keeps this change focused on authorization and tenant isolation.

### Test-only alternate server entrypoint

Rejected because it would weaken the black-box E2E guarantee. The E2E suite continues to run the real server entrypoint and normal production composition code.

## Acceptance criteria

- `/users` is protected by application-layer scope checks.
- anonymous access returns 401.
- invalid static bearer credentials return 401 without secret leakage.
- authenticated requests without tenant or required scope return 403.
- cross-tenant user lookup returns 404 without an unscoped existence check.
- all user repository reads require tenant ID in the method signature and SQL predicate.
- user creation derives tenant ID only from `RequestContext`.
- `users.tenant_id` is NOT NULL after migration.
- email uniqueness is `(tenant_id, email)`.
- existing pre-tenant rows migrate to inaccessible reserved legacy tenant IDs.
- static bearer auth is disabled by default and rejected under `NODE_ENV=production`.
- real-process E2E runs authenticated create/read and proves cross-tenant isolation using sequential tenant A/B server processes over the same database.
- same email can be created by two different tenants.
- OpenAPI snapshot documents 401/403 and contract gates remain green.
- no raw auth credential is logged or returned.
- final feature branch, PR-triggered head, and squash-merged main all pass the repository's required CI jobs.
