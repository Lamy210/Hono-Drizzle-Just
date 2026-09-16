# Tenant Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the sample `/users` API with scope-based authorization and tenant-isolated persistence, including tenant-local email uniqueness and real-process E2E coverage.

**Architecture:** Authorization stays provider-neutral and lives at the application boundary. `requireTenantScope()` derives an authorized tenant context from `RequestContext`, services pass that tenant to repository ports whose signatures require tenant scope, and Drizzle queries include `tenant_id` predicates. Production composition may opt into a test/development-only static bearer resolver; production mode rejects that adapter.

**Tech Stack:** Bun 1.4.2, TypeScript 7.0.2, Hono 4.13.7, `@hono/zod-openapi` 1.6.3, Drizzle ORM 0.45.2 / drizzle-kit 0.31.10, PostgreSQL 18, Bun test.

**Spec:** `docs/superpowers/specs/2026-09-16-tenant-authorization-design.md`

## Global Constraints

- Application permission vocabulary is `users:read` and `users:write`; application services do not authorize from `roles`.
- Tenant IDs are opaque case-sensitive strings, 1..128 characters, trimmed already, without control characters, and must not start with `__legacy__:`.
- Anonymous access is 401; authenticated-but-insufficient access is 403; cross-tenant reads are indistinguishable from missing rows and return 404.
- No unscoped `UserRepository.findById(id)` or `findByEmail(email)` remains.
- `users.tenant_id` is NOT NULL and email uniqueness is `(tenant_id, email)`.
- Existing rows are backfilled to reserved `__legacy__:<user-id>` tenant IDs; the initial migration is not rewritten.
- Development static bearer authentication is disabled by default and is invalid when `NODE_ENV=production`.
- Raw bearer tokens, authorization/cookie values, scopes, and credential material must not be copied into logs, telemetry, responses, or errors.
- The black-box test still executes `bun run start`, uses one migrated database, and runs tenant A then tenant B server processes sequentially.
- OpenAPI remains generated from runtime `createApp()` and must document 401/403 for protected user operations.

---

### Task 1: Core tenant authorization contract

**Files:**
- Create: `src/core/auth/tenant-authorization.ts`
- Modify: `src/core/errors/app-error.ts`
- Create: `tests/unit/core/auth/tenant-authorization.test.ts`

**Interfaces:**
- Consumes: `RequestContext`, `Principal`, `AppError`.
- Produces:
  ```ts
  export interface TenantAuthorization {
    readonly subject: string;
    readonly tenantId: string;
  }
  export function isValidTenantId(value: string): boolean;
  export function requireTenantScope(
    context: RequestContext,
    requiredScope: string,
  ): TenantAuthorization;
  ```

- [ ] **Step 1: Write the failing authorization tests**

  Cover anonymous 401, missing/invalid/reserved tenant 403, missing scope 403, valid scope success, case-sensitive tenant preservation, and ensure client-visible messages do not reveal the required scope.

  ```ts
  expect(() => requireTenantScope(baseContext, "users:read")).toThrow(
    expect.objectContaining({ code: "UNAUTHORIZED", status: 401 }),
  );
  expect(() => requireTenantScope(context({ tenantId: "tenant-a", scopes: [] }), "users:read"))
    .toThrow(expect.objectContaining({ code: "FORBIDDEN", status: 403 }));
  expect(requireTenantScope(context({ tenantId: "Tenant-A", scopes: ["users:read"] }), "users:read"))
    .toEqual({ subject: "user-1", tenantId: "Tenant-A" });
  ```

- [ ] **Step 2: Run RED**

  Run: `bun test tests/unit/core/auth/tenant-authorization.test.ts`
  Expected: FAIL because `tenant-authorization.ts`, `FORBIDDEN`, and status 403 do not exist.

- [ ] **Step 3: Implement the minimal core helper**

  `isValidTenantId()` must enforce non-empty, maximum 128, exact trim equality, no U+0000..U+001F/U+007F controls, and reject the reserved prefix. `requireTenantScope()` throws sanitized `UNAUTHORIZED`/`FORBIDDEN` errors and returns only normalized subject/tenant data.

- [ ] **Step 4: Run GREEN**

  Run: `bun test tests/unit/core/auth/tenant-authorization.test.ts && bun run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  Commit message: `feat: add tenant authorization boundary`

---

### Task 2: Safe development static bearer resolver and typed configuration

**Files:**
- Create: `src/infrastructure/auth/static-bearer-principal-resolver.ts`
- Modify: `src/config/config.schema.ts`
- Modify: `src/app/composition/container.ts`
- Modify: `.env.example`
- Modify: `tests/unit/config/load-config.test.ts`
- Create: `tests/unit/infrastructure/auth/static-bearer-principal-resolver.test.ts`
- Create: `tests/unit/app/composition/container-auth.test.ts`

**Interfaces:**
- Produces configuration fields:
  ```ts
  readonly authDevStaticEnabled: boolean;
  readonly authDevStaticBearerToken?: string;
  readonly authDevStaticSubject?: string;
  readonly authDevStaticTenantId?: string;
  readonly authDevStaticScopes: readonly string[];
  ```
- Produces `StaticBearerPrincipalResolver implements PrincipalResolver` whose constructor accepts `{ token, subject, tenantId, scopes }`.

- [ ] **Step 1: Write failing config/resolver/composition tests**

  Assert safe disabled defaults; production-mode enablement rejection; required fields/bounds when enabled; scope deduplication; configuration errors do not contain the bearer token; absent auth resolves undefined; malformed/wrong bearer throws `UNAUTHORIZED`; correct bearer returns the server-configured principal; and composition wires a resolver only when enabled.

- [ ] **Step 2: Run RED**

  Run: `bun test tests/unit/config/load-config.test.ts tests/unit/infrastructure/auth/static-bearer-principal-resolver.test.ts tests/unit/app/composition/container-auth.test.ts`
  Expected: FAIL because the configuration and resolver do not exist.

- [ ] **Step 3: Implement configuration parsing**

  Add the five `AUTH_DEV_STATIC_*` variables. Keep secret values out of Zod issue messages by using generic validation messages. Parse scopes from a <=2048-character string, split on ASCII spaces, remove empties, deduplicate, cap at 32, and validate each scope with `/^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/`.

- [ ] **Step 4: Implement resolver and composition wiring**

  The resolver accepts only `Bearer <token>`. Compare same-length UTF-8 token bytes with `crypto.subtle.timingSafeEqual` equivalent available in the runtime (`node:crypto.timingSafeEqual` is acceptable); wrong/malformed supplied credentials throw sanitized 401. Production composition creates it only when `authDevStaticEnabled` is true.

- [ ] **Step 5: Run GREEN**

  Run: `bun test tests/unit/config/load-config.test.ts tests/unit/infrastructure/auth/static-bearer-principal-resolver.test.ts tests/unit/app/composition/container-auth.test.ts && bun run typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**

  Commit message: `feat: add opt-in static bearer auth adapter`

---

### Task 3: Tenant-owned user persistence and migration

**Files:**
- Modify: `src/db/schema/users.ts`
- Modify: `src/modules/users/domain/user.ts`
- Modify: `src/modules/users/domain/user.repository.ts`
- Modify: `src/modules/users/infrastructure/drizzle-user.repository.ts`
- Modify: `tests/factories/user.factory.ts`
- Modify: `tests/integration/factories/user.factory.test.ts`
- Modify: `tests/integration/modules/users/drizzle-user.repository.test.ts`
- Modify: `tests/integration/modules/users/drizzle-user.repository-observability.test.ts`
- Generated by drizzle-kit: next `drizzle/0001_*.sql`, `drizzle/meta/0001_snapshot.json`, and updated `drizzle/meta/_journal.json`

**Interfaces:**
- `User` gains `readonly tenantId: string`.
- Add:
  ```ts
  export interface TenantScopedCreateUserInput extends CreateUserInput {
    readonly tenantId: string;
  }
  ```
- Repository becomes:
  ```ts
  findById(tenantId: string, id: string): Promise<User | null>;
  findByEmail(tenantId: string, email: string): Promise<User | null>;
  create(input: TenantScopedCreateUserInput): Promise<User>;
  ```

- [ ] **Step 1: Write failing integration/factory tests against the tenant-aware signatures**

  Prove tenant A rows are invisible through tenant B lookups, same email can be inserted in separate tenants, duplicate email conflicts inside one tenant, and factories default to a safe test tenant while allowing overrides.

- [ ] **Step 2: Run RED in PostgreSQL CI context**

  Run: `DATABASE_URL=... bun test tests/integration/factories/user.factory.test.ts tests/integration/modules/users/drizzle-user.repository.test.ts`
  Expected: compile/runtime failure because schema and repository signatures are still unscoped.

- [ ] **Step 3: Implement schema/domain/repository changes**

  Define `tenantId: varchar("tenant_id", { length: 128 }).notNull()` and a named composite unique constraint on `(tenantId, email)`. Use `and(eq(users.tenantId, tenantId), eq(...))` on every read. Inserts accept tenant ID only through `TenantScopedCreateUserInput`. Preserve low-cardinality observability attributes.

- [ ] **Step 4: Generate the Drizzle migration using repository Bun/drizzle-kit**

  Run `bun run db:generate`. The generated migration is then reviewed and, if drizzle-kit cannot express the safe existing-row transition automatically, edit only the new migration SQL so it performs this exact sequence:

  ```sql
  ALTER TABLE "users" ADD COLUMN "tenant_id" varchar(128);
  UPDATE "users" SET "tenant_id" = '__legacy__:' || "id"::text WHERE "tenant_id" IS NULL;
  ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;
  ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";
  ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_email_unique" UNIQUE("tenant_id","email");
  ```

  Keep drizzle-kit generated metadata synchronized with the final TypeScript schema; do not rewrite `0000_initial.sql`.

- [ ] **Step 5: Run migration/repository GREEN**

  Run: `bun run db:check && bun run db:migrations:verify && bun run ci:integration`
  Expected: PASS.

- [ ] **Step 6: Commit**

  Commit message: `feat: scope user persistence by tenant`

---

### Task 4: Enforce scope/tenant authorization in services and API routes

**Files:**
- Modify: `src/modules/users/application/create-user.service.ts`
- Modify: `src/modules/users/application/get-user.service.ts`
- Modify: `src/modules/users/presentation/user.routes.ts`
- Modify: `tests/unit/modules/users/create-user.service.test.ts`
- Create: `tests/unit/modules/users/get-user.service.test.ts`
- Modify: `tests/api/users.test.ts`

**Interfaces:**
- `CreateUserService.execute(input, context)` remains its public signature but calls `requireTenantScope(context, "users:write")` before repository work.
- `GetUserService.execute(id, context)` changes to require `RequestContext` and calls `requireTenantScope(context, "users:read")`.

- [ ] **Step 1: Rewrite/add failing service tests**

  Create a reusable authorized `RequestContext` with `tenant-a`. Assert `findByEmail("tenant-a", normalizedEmail)`, `create({ tenantId: "tenant-a", ... })`, and `findById("tenant-a", canonicalId)`. Add 401/403 tests and assert repository methods are not invoked after denied authorization.

- [ ] **Step 2: Write failing API tests**

  Update `buildApp()` fixtures to include internal `tenantId`. Cover anonymous 401, missing scope 403, authorized create/read, uppercase UUID still canonicalized after authorization, cross-tenant 404, and ignored client attempts to send `tenantId` in the body.

- [ ] **Step 3: Run RED**

  Run: `bun test tests/unit/modules/users tests/api/users.test.ts`
  Expected: FAIL because services/routes do not yet enforce scopes or pass context for GET.

- [ ] **Step 4: Implement services/routes**

  Authorization happens before repository lookup. `GetUserService` performs exactly one tenant-scoped lookup and returns `NOT_FOUND` when it returns null. Route handlers pass `c.get("requestContext")` to both services.

- [ ] **Step 5: Run GREEN**

  Run: `bun test tests/unit/modules/users tests/api/users.test.ts tests/api/principal-context.test.ts && bun run typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**

  Commit message: `feat: protect user services with tenant scopes`

---

### Task 5: Public API contract and OpenAPI snapshot

**Files:**
- Modify: `src/modules/users/presentation/user.routes.ts`
- Generated: `openapi/openapi.json`
- Existing contract tests: `tests/unit/tooling/openapi-contract-gate.test.ts`

- [ ] **Step 1: Add 401/403 response declarations**

  Both user routes use `ErrorResponseSchema` for 401/403. Do not add an OpenAPI bearer security scheme in this change.

- [ ] **Step 2: Generate the snapshot**

  Run: `bun run openapi:generate`
  Expected diff: user operations gain 401/403 only; `UserResponse` still does not expose `tenantId`.

- [ ] **Step 3: Verify contract**

  Run: `bun run openapi:contract`
  Expected: PASS. oasdiff may report additive response documentation but no breaking error against the new snapshot itself.

- [ ] **Step 4: Commit**

  Commit message: `docs: expose authorization errors in OpenAPI`

---

### Task 6: Real-process tenant isolation E2E

**Files:**
- Modify: `tests/e2e/server.e2e.test.ts`

**Interfaces:**
- Add a local `startServer(identity)` helper that allocates a port, starts `bun run start`, configures `AUTH_DEV_STATIC_*`, captures stdout/stderr, waits for readiness, and exposes a bounded shutdown function.

- [ ] **Step 1: Rewrite E2E test for two sequential authenticated servers**

  Server A configuration:
  ```ts
  {
    token: "e2e-a-0123456789abcdef0123456789abcdef",
    subject: "e2e-user-a",
    tenantId: "tenant-e2e-a",
    scopes: "users:read users:write",
  }
  ```

  First assert unauthenticated POST returns 401. Then create/fetch a user with A, shut A down cleanly, start B against the same `DATABASE_URL`, assert A's ID is 404, create the same email under B with 201, fetch B's row, and shut B down cleanly.

- [ ] **Step 2: Run E2E GREEN**

  Run: `DATABASE_URL=... bun run ci:e2e`
  Expected: PASS with both server processes producing `server.stopping` and `server.stopped`.

- [ ] **Step 3: Commit**

  Commit message: `test: prove tenant isolation through production server`

---

### Task 7: Documentation, full verification, review, and merge readiness

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/architecture.md`
- Modify as needed: `.github/pull_request_template.md`

- [ ] **Step 1: Document the authorization boundary and safe static-auth usage**

  Document `users:read` / `users:write`, 401/403/404 semantics, tenant-local email uniqueness, static bearer variables, production-mode rejection, and the requirement to replace the development resolver with a real IdP adapter for deployed applications. Never provide a real token value in `.env.example`; leave secret values empty.

- [ ] **Step 2: Run DB-free verification**

  Run: `bun run check:fast && bun run test:coverage && bun run openapi:contract`
  Expected: PASS and coverage remains >=80% lines / >=75% functions.

- [ ] **Step 3: Run database/full verification**

  Run: `bun run check && bun run ci:integration && bun run ci:e2e`
  Expected: PASS against PostgreSQL 18.

- [ ] **Step 4: Inspect final diff for security invariants**

  Confirm there is no unscoped user repository lookup, no token in logs/errors/docs, no tenant IDs in telemetry attributes, no rewritten baseline migration, no dependency/toolchain drift, and no test-only alternate server entrypoint.

- [ ] **Step 5: Commit documentation/final synchronization**

  Commit message: `docs: document tenant authorization model`

- [ ] **Step 6: Open PR and require all six repository jobs**

  PR must show green `quality`, `coverage`, `contract`, `integration`, `e2e`, and `required`. Review changed files and unresolved review threads before squash merge with expected head SHA.

- [ ] **Step 7: Verify squash-merged main**

  The main push CI for the merge SHA must complete successfully across all six jobs before the feature is declared complete.
