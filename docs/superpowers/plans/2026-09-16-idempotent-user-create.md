# Idempotent User Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional, tenant-scoped `Idempotency-Key` handling to `POST /users` with PostgreSQL-backed concurrency safety, replay, mismatch rejection, and no new external infrastructure.

**Architecture:** `CreateUserService` remains the application security/transaction boundary. A SHA-256 digester hashes the raw key and canonical normalized payload before persistence; a transaction-scoped `UserCreationIdempotencyRepository` claims/replays keys in the same PostgreSQL transaction as user creation. The HTTP layer only validates/forwards the optional header and documents the resulting 400/422 behavior.

**Tech Stack:** Bun 1.4.2, TypeScript 7, Hono 4 + `@hono/zod-openapi`, Zod 4, Drizzle ORM 0.45 / drizzle-kit 0.31, PostgreSQL 18 in CI, Bun test, Biome, Redocly, oasdiff.

**Spec:** `docs/superpowers/specs/2026-09-16-idempotent-user-create-design.md`

## Global Constraints

- `Idempotency-Key` is optional; requests without it preserve current behavior.
- Key contract: 1..255 visible ASCII characters (`0x21..0x7E`), opaque and case-sensitive.
- Raw idempotency keys never enter PostgreSQL, logs, telemetry attributes, error bodies, or `RequestContext`.
- Key hash and request fingerprint use lowercase SHA-256 hex.
- Fingerprint source is exactly `users:create:v1\n<normalized-email>\n<normalized-name>`.
- Active replay window is 24 hours; expiry uses PostgreSQL `now()` and lazy same-key reclaim only.
- Same tenant/key/same normalized payload replays the original user with HTTP 201.
- Same tenant/key/different normalized payload returns sanitized HTTP 422 with code `IDEMPOTENCY_KEY_REUSED`.
- Same raw key is independent across tenants.
- Fresh claim, user insert, and claim completion commit or roll back atomically in one PostgreSQL transaction.
- No unscoped user lookup may be added.
- No Redis/Valkey/new external infrastructure dependency.
- `drizzle/0000_initial.sql` and `drizzle/0001_mean_barracuda.sql` remain immutable.
- Final push CI, PR CI including oasdiff base comparison, and post-merge main CI must pass all required jobs.

---

### Task 1: Idempotency header contract and SHA-256 boundary

**Files:**
- Create: `src/core/crypto/string-digester.ts`
- Create: `src/infrastructure/crypto/sha256-string-digester.ts`
- Create: `src/contracts/common/idempotency.ts`
- Modify: `src/core/errors/app-error.ts`
- Test: `tests/unit/infrastructure/sha256-string-digester.test.ts`
- Test: `tests/unit/contracts/idempotency.test.ts`

**Interfaces:**
- Produces: `StringDigester.sha256Hex(value: string): string`
- Produces: `Sha256StringDigester implements StringDigester`
- Produces: `IdempotencyKeySchema` and `IdempotencyKeyHeadersSchema`
- Produces: `AppErrorCode` member `IDEMPOTENCY_KEY_REUSED` and status `422`

- [ ] **Step 1: Write failing key-validation tests**

Test exact boundaries: `"a"`, 255 visible ASCII chars, empty string, 256 chars, space, tab/newline, DEL, Unicode. Valid values must preserve case and bytes unchanged.

```ts
expect(IdempotencyKeySchema.parse("Key-A")).toBe("Key-A");
expect(() => IdempotencyKeySchema.parse("")).toThrow();
expect(() => IdempotencyKeySchema.parse("a b")).toThrow();
expect(() => IdempotencyKeySchema.parse("é")).toThrow();
```

- [ ] **Step 2: Write failing digest tests**

Assert the adapter returns the standard SHA-256 lowercase hex for `"abc"`:

```text
ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
```

Also assert output is exactly 64 lowercase hex characters and no input is logged or otherwise exposed.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `bun test tests/unit/contracts/idempotency.test.ts tests/unit/infrastructure/sha256-string-digester.test.ts`

Expected: FAIL because schemas/ports/adapter/error code do not exist yet.

- [ ] **Step 4: Implement minimal contract and digester**

Create:

```ts
export interface StringDigester {
  sha256Hex(value: string): string;
}
```

Implement with `createHash("sha256").update(value, "utf8").digest("hex")` in infrastructure.

Define the key schema with a refinement that requires every code point to be between `0x21` and `0x7e`, length 1..255, and export:

```ts
export const IdempotencyKeyHeadersSchema = z.object({
  "idempotency-key": IdempotencyKeySchema.optional(),
});
```

Extend `AppErrorCode` with `IDEMPOTENCY_KEY_REUSED` and `AppErrorStatus` with `422`.

- [ ] **Step 5: Run focused tests and quality checks**

Run: `bun test tests/unit/contracts/idempotency.test.ts tests/unit/infrastructure/sha256-string-digester.test.ts`

Run: `bun run lint && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/crypto src/infrastructure/crypto src/contracts/common/idempotency.ts src/core/errors/app-error.ts tests/unit/contracts tests/unit/infrastructure/sha256-string-digester.test.ts
git commit -m "feat: add idempotency contract primitives"
```

---

### Task 2: PostgreSQL idempotency ledger and transactional repository

**Files:**
- Create: `src/db/schema/user-creation-idempotency.ts`
- Modify: `src/db/schema/index.ts`
- Create: `src/modules/users/application/user-creation-idempotency.repository.ts`
- Modify: `src/modules/users/application/user-unit-of-work.ts`
- Create: `src/modules/users/infrastructure/drizzle-user-creation-idempotency.repository.ts`
- Modify: `src/app/composition/database-access.ts`
- Generate: `drizzle/0002_*.sql`, `drizzle/meta/0002_snapshot.json`, `drizzle/meta/_journal.json`
- Test: `tests/integration/modules/users/drizzle-user-creation-idempotency.repository.test.ts`
- Test: `tests/integration/modules/users/drizzle-user-creation-idempotency.repository-observability.test.ts`
- Test: `tests/unit/tooling/idempotency-migration.test.ts`

**Interfaces:**
- Produces:

```ts
export interface UserCreationIdempotencyRecord {
  readonly requestFingerprint: string;
  readonly userId: string | null;
}

export type UserCreationIdempotencyClaim =
  | { readonly state: "claimed" }
  | { readonly state: "existing"; readonly record: UserCreationIdempotencyRecord };

export interface UserCreationIdempotencyRepository {
  claim(input: {
    tenantId: string;
    keyHash: string;
    requestFingerprint: string;
    ttlSeconds: number;
  }): Promise<UserCreationIdempotencyClaim>;
  complete(input: {
    tenantId: string;
    keyHash: string;
    requestFingerprint: string;
    userId: string;
  }): Promise<void>;
}
```

- Extends `UserUnitOfWork` with `userCreationIdempotency`.

- [ ] **Step 1: Write migration/schema RED tests**

Require a new table with columns `tenant_id varchar(128)`, `key_hash char(64)`, `request_fingerprint char(64)`, nullable `user_id uuid`, `claimed_at timestamptz`, `expires_at timestamptz`, primary key `(tenant_id,key_hash)`, and FK `user_id -> users.id ON DELETE CASCADE`. Assert existing migration files are unchanged and the next migration is additive.

- [ ] **Step 2: Write repository RED tests against PostgreSQL**

Cover:
- fresh claim -> `claimed`;
- active same key -> `existing` with stored fingerprint/user ID;
- same key across tenants independent;
- expired row reclaim -> `claimed` and new fingerprint, null user ID;
- `complete()` affects exactly the matching tenant/key/fingerprint incomplete row;
- `complete()` throws an invariant error when zero rows match;
- persisted key is a supplied 64-char hash only; raw test key never appears in table data.

- [ ] **Step 3: Write real concurrency RED**

Use two separate DB transactions/connections to call `claim()` concurrently for the same tenant/key. Hold the first transaction open long enough to establish that the second waits. Commit the winner and require the waiter to return `existing` rather than `claimed`.

- [ ] **Step 4: Run integration/tooling tests and confirm RED**

Run: `bun test tests/unit/tooling/idempotency-migration.test.ts`

Run with CI PostgreSQL: `bun test tests/integration/modules/users/drizzle-user-creation-idempotency.repository.test.ts`

Expected: FAIL because schema/repository/migration do not exist.

- [ ] **Step 5: Implement schema and port**

Use a composite primary key on `(tenantId, keyHash)` and `char(64)` for both hashes. Keep `userId` nullable in schema because the owning transaction temporarily holds an incomplete claim.

- [ ] **Step 6: Implement `claim()` with a bounded three-attempt loop**

Per attempt:
1. `UPDATE ... WHERE tenant_id=? AND key_hash=? AND expires_at <= now()` resetting fingerprint/user/claimed/expires; if returned -> `claimed`.
2. `INSERT ... ON CONFLICT DO NOTHING RETURNING ...`; if returned -> `claimed`.
3. tenant/key exact `SELECT`; if active -> `existing`; if row is now expired, retry.
4. after three attempts, throw an internal invariant error.

Use PostgreSQL `now() + (ttlSeconds * interval '1 second')` semantics, never application wall clock.

- [ ] **Step 7: Implement `complete()`**

Update exact tenant/key/fingerprint row with `user_id IS NULL`; require exactly one returned row. Throw an `AppError("INTERNAL_ERROR", "Idempotency state is inconsistent", 500)` or equivalent sanitized invariant on mismatch.

- [ ] **Step 8: Wire transaction unit of work**

`createDatabaseAccess()` must create both transaction-scoped repositories from the same Drizzle transaction session and observer.

- [ ] **Step 9: Generate migration with pinned toolchain**

Run: `bun run db:generate` (or the repository's existing drizzle generation command).

Review generated SQL and metadata. Do not edit `0000_initial.sql` or `0001_mean_barracuda.sql`.

- [ ] **Step 10: Run GREEN integration/migration/observability tests**

Run: `bun run db:migrations:verify`

Run: `bun run ci:integration`

Expected: all pass, including concurrency and low-cardinality observability tests.

- [ ] **Step 11: Commit**

```bash
git add src/db src/modules/users/application src/modules/users/infrastructure src/app/composition/database-access.ts drizzle tests/integration tests/unit/tooling/idempotency-migration.test.ts
git commit -m "feat: add transactional idempotency ledger"
```

---

### Task 3: CreateUserService idempotency semantics

**Files:**
- Modify: `src/modules/users/application/create-user.service.ts`
- Modify: `src/app/composition/container.ts`
- Test: `tests/unit/modules/users/create-user.service.test.ts`
- Test: `tests/integration/modules/users/idempotent-create-user.service.test.ts`

**Interfaces:**
- Consumes: `StringDigester`, `UserCreationIdempotencyRepository` through `UserUnitOfWork`.
- Produces:

```ts
execute(
  input: CreateUserInput,
  context: RequestContext,
  options?: { readonly idempotencyKey?: string },
): Promise<User>
```

- Uses `IDEMPOTENCY_TTL_SECONDS = 86_400`.

- [ ] **Step 1: Write service RED tests**

Cover:
- no-key path never calls the idempotency repository and preserves current behavior;
- fresh claim hashes raw key and canonical normalized payload, then creates/completes exactly once;
- same fingerprint existing record loads via `users.findById(tenantId,userId)` and returns without create;
- replay emits no second `user.created` log;
- different fingerprint throws sanitized `IDEMPOTENCY_KEY_REUSED` 422;
- existing record with null userId fails closed with 500;
- completed record pointing to missing tenant-local user fails closed with 500;
- raw key is passed only to the digester, never repository/logger.

- [ ] **Step 2: Confirm RED**

Run: `bun test tests/unit/modules/users/create-user.service.test.ts`

Expected: idempotency cases fail while existing no-key cases remain green.

- [ ] **Step 3: Implement canonical fingerprint helper inside the service module or a focused adjacent module**

Exact source:

```ts
`users:create:v1\n${normalized.email}\n${normalized.name}`
```

Hash raw key and canonical source before starting the transaction.

- [ ] **Step 4: Implement fresh/replay/mismatch state machine**

Keep authorization first. For key path, perform `claim()` inside transaction. A fresh claim executes existing tenant-local duplicate-email check, inserts user, calls `complete()`, and returns `{ user, created: true }`. Existing same-fingerprint record tenant-loads user and returns `{ user, created: false }`. Mismatch throws 422. Emit business log only when `created` is true after the transaction commits.

- [ ] **Step 5: Wire SHA-256 adapter in composition**

Create one `Sha256StringDigester` and inject it into `CreateUserService`. Do not add configuration or external dependencies.

- [ ] **Step 6: Write full-operation PostgreSQL concurrency test**

Run two `CreateUserService.execute()` calls concurrently with the same tenant/key/payload, backed by real transactions/connections. Require both results to have the same user ID and query the database to prove exactly one tenant/email row exists and one completed ledger row references it.

- [ ] **Step 7: Test failed transaction rollback**

Trigger a tenant-local duplicate email after a fresh claim; require 409 and then verify no idempotency ledger row remains committed for that key.

- [ ] **Step 8: Run unit + integration GREEN**

Run: `bun test tests/unit/modules/users/create-user.service.test.ts`

Run: `bun run ci:integration`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/users/application/create-user.service.ts src/app/composition/container.ts tests/unit/modules/users/create-user.service.test.ts tests/integration/modules/users/idempotent-create-user.service.test.ts
git commit -m "feat: make user creation idempotent"
```

---

### Task 4: HTTP/OpenAPI/E2E integration and documentation

**Files:**
- Modify: `src/modules/users/presentation/user.routes.ts`
- Modify: `openapi/openapi.json`
- Modify: `tests/api/users.test.ts`
- Modify: `tests/e2e/server.e2e.test.ts`
- Modify: `tests/unit/tooling/openapi-contract-gate.test.ts` only if fixture changes require it
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: `IdempotencyKeyHeadersSchema` and `CreateUserService.execute(..., { idempotencyKey })`.
- Produces: optional `Idempotency-Key` header in OpenAPI and documented 422 error.

- [ ] **Step 1: Write API RED tests**

Cover omitted key, invalid key 400, same key/same payload replay 201 same ID, same key/different normalized payload 422, normalization-equivalent payload replay, same raw key independent across tenant principals, client `tenantId` field cannot alter scope, and error body does not echo the key.

- [ ] **Step 2: Confirm API RED**

Run: `bun test tests/api/users.test.ts`

Expected: new header/replay/mismatch assertions fail.

- [ ] **Step 3: Wire validated header into route**

Declare:

```ts
request: {
  headers: IdempotencyKeyHeadersSchema,
  body: ...
}
```

Read `const { "idempotency-key": idempotencyKey } = c.req.valid("header")` and pass only the optional string to the service. Add documented 422 response using `ErrorResponseSchema`.

- [ ] **Step 4: Regenerate OpenAPI snapshot**

Run: `bun run openapi:generate`

Then: `bun run openapi:contract`

Expected: snapshot, Redocly validation, and internal contract tests pass.

- [ ] **Step 5: Extend production-entrypoint E2E**

On the authenticated tenant server, POST with a deterministic high-entropy key twice and require 201 + same user ID. POST changed payload with same key and require 422. Preserve the existing tenant A/B cross-tenant and graceful shutdown assertions.

- [ ] **Step 6: Update docs**

Document optional header, tenant-local scope, 24-hour replay window/lazy reclaim, 422 mismatch, hashed persistence, high-entropy client recommendation, no Redis/background worker, and the fact that expiry permits key reuse but does not bypass normal email uniqueness.

- [ ] **Step 7: Run API/OpenAPI/E2E checks**

Run: `bun test tests/api/users.test.ts`

Run: `bun run openapi:contract`

Run: `bun run ci:e2e`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/modules/users/presentation/user.routes.ts openapi tests/api tests/e2e README.md docs/architecture.md CONTRIBUTING.md
git commit -m "feat: expose idempotent user creation contract"
```

---

### Task 5: Final verification, review, PR, merge, and main verification

**Files:**
- Review all branch changes against `main`.
- No production changes unless review or verification finds a concrete defect.

**Interfaces:**
- Consumes all previous tasks.
- Produces a reviewed, merged PR with green post-merge CI.

- [ ] **Step 1: Run complete branch verification**

Run the repository equivalents of:

```bash
bun run check
bun run test:coverage
bun run openapi:contract
bun run ci:integration
bun run ci:e2e
```

On GitHub Actions require `quality`, `coverage`, `contract`, `integration`, `e2e`, and aggregate `required` all green on the exact final head.

- [ ] **Step 2: Security/privacy diff review**

Explicitly inspect for:
- raw idempotency key persistence/logging/telemetry/error leakage;
- unscoped user lookup;
- tenant omitted from ledger primary key/query predicates;
- incomplete claims capable of committing;
- concurrency tests that accidentally share one transaction instead of separate connections;
- accidental mutation of `0000`/`0001` migrations;
- dependency/toolchain drift.

If a defect is found, add a failing regression test first, apply the minimal fix, and rerun all affected verification.

- [ ] **Step 3: Create PR**

Title: `feat: add idempotent user creation`

PR body must summarize semantics, migration, security/privacy invariants, concurrency proof, E2E behavior, and exact final CI head/run evidence.

- [ ] **Step 4: Verify PR-triggered contract comparison**

Require PR CI all green and specifically confirm the oasdiff base-vs-head breaking-change step executes and succeeds rather than being skipped.

- [ ] **Step 5: Review PR feedback/threads**

Check review submissions and inline threads. Resolve only with evidence; any code change requires fresh CI on the new head.

- [ ] **Step 6: Squash merge exact reviewed head**

Use the exact expected PR head SHA. Commit title: `feat: add idempotent user creation (#<PR>)`.

- [ ] **Step 7: Verify post-merge main CI**

Require the main merge commit itself to pass `quality`, `coverage`, `contract`, `integration`, `e2e`, and `required` before declaring completion.
