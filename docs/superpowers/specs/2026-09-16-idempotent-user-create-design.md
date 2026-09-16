# Idempotent User Creation Design

## Status

Approved design for implementing optional `Idempotency-Key` handling on `POST /users`.

## Context

`POST /users` already has three important properties:

1. tenant authorization is enforced in `CreateUserService` using the authenticated `RequestContext`;
2. email/name normalization and tenant-local duplicate detection happen in the application layer;
3. duplicate detection and user insertion run inside one PostgreSQL transaction through `UserTransactionManager`.

The next step is to make retried create requests safe without introducing a second datastore or a transport-only idempotency layer.

The template should demonstrate idempotency that remains correct across process restarts and multiple application instances, and that preserves the tenant boundary added in PR #27.

## Goals

- Add optional `Idempotency-Key` support to `POST /users` without breaking clients that omit the header.
- Guarantee that concurrent requests using the same tenant/key/payload create at most one user.
- Replay the original user response for a repeated request using the same tenant/key/payload.
- Reject reuse of the same active tenant/key with a different normalized payload using HTTP 422.
- Allow the same key to be reused independently by different tenants.
- Keep raw idempotency keys out of PostgreSQL, logs, telemetry, error responses, and request context.
- Keep idempotency ownership and user creation in the same PostgreSQL transaction.
- Preserve the existing tenant-local email uniqueness contract and cross-tenant isolation.
- Add real PostgreSQL concurrency coverage and production-entrypoint E2E coverage.

## Non-goals

- Making every mutation in the template idempotent in this change.
- Adding Redis, Valkey, a distributed lock service, or another infrastructure dependency.
- Adding a background cleanup worker or scheduler.
- Defining a global reusable idempotency middleware before multiple operations need it.
- Treating `Idempotency-Key` as an authentication or authorization mechanism.
- Claiming conformance to an RFC for `Idempotency-Key`; the implementation uses an application-owned contract.
- Returning a custom replay-status response header in this phase.

## Chosen approach

Use a PostgreSQL-backed, feature-scoped idempotency ledger named `user_creation_idempotency`.

The ledger participates in the same transaction as tenant-local duplicate-email detection and user insertion. PostgreSQL uniqueness and row locking provide serialization for concurrent requests with the same tenant/key.

This is preferred over Redis because it avoids a dual-write problem between an idempotency store and PostgreSQL. It is preferred over process memory because memory cannot survive restarts or coordinate multiple instances.

## HTTP contract

`POST /users` accepts an optional `Idempotency-Key` request header.

### Key validation

When present, the key must:

- be 1 to 255 characters;
- consist only of visible ASCII characters `0x21` through `0x7E`;
- therefore contain no spaces, C0/C1 controls, or Unicode ambiguity;
- be treated as an opaque, case-sensitive value.

An invalid supplied key returns the existing validation-error shape with HTTP 400. Omitting the key preserves the current non-idempotent create behavior.

The route contract declares the header through the existing `@hono/zod-openapi` request-header schema and reads the validated header using `c.req.valid("header")`.

### Success semantics

Without an idempotency key:

- behavior is unchanged;
- a successful create returns 201 with `UserResponseSchema`.

With an idempotency key:

- the first successful request returns 201 with the created user;
- a later request in the same tenant using the same key and same normalized payload returns 201 with the same user representation and same user ID;
- a later request in a different tenant may use the same raw key independently;
- replay does not create a second user and does not emit a second `user.created` business log event.

No custom `Idempotency-Replayed` response header is added in this phase.

### Payload mismatch

If the same unexpired tenant/key is reused with a different normalized payload, return:

- HTTP 422;
- application error code `IDEMPOTENCY_KEY_REUSED`;
- a generic message such as `Idempotency key was already used with a different request`.

The error must not include the raw key, key hash, request fingerprint, tenant ID, prior payload, or prior user ID.

`AppErrorStatus` gains 422 and `AppErrorCode` gains `IDEMPOTENCY_KEY_REUSED`.

## Canonical payload and hashing

The idempotency comparison is based on the application-normalized request rather than raw JSON bytes.

For user creation, normalize exactly as the service already does:

- `email = input.email.trim().toLowerCase()`;
- `name = input.name.trim()`.

Build a canonical fingerprint source using a fixed field order and an operation/version namespace:

```text
users:create:v1\n<normalized-email>\n<normalized-name>
```

Hash this source with SHA-256 and encode it as lowercase hexadecimal.

Hash the raw idempotency key separately with SHA-256 and lowercase hexadecimal before any persistence call.

The operation/version prefix ensures future semantic changes can deliberately use a new fingerprint namespace without changing historical rows.

### Hashing boundary

Application code depends on a small feature-neutral digest port:

```ts
export interface StringDigester {
  sha256Hex(value: string): string;
}
```

A runtime adapter under infrastructure implements this with `node:crypto` and is wired by composition. Core/application policy never depends directly on the Node crypto API.

The digester is deterministic and does not log or retain inputs.

## Persistence model

Add a new table:

```text
user_creation_idempotency
- tenant_id             varchar(128)  NOT NULL
- key_hash              char(64)      NOT NULL
- request_fingerprint   char(64)      NOT NULL
- user_id               uuid          NULL
- claimed_at            timestamptz   NOT NULL DEFAULT now()
- expires_at            timestamptz   NOT NULL
PRIMARY KEY (tenant_id, key_hash)
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
```

Properties:

- the raw key is never stored;
- the tenant ID is part of the primary key, so identical keys are independent across tenants;
- `user_id` is nullable only while a transaction owns a fresh claim;
- a committed successful claim must have a non-null `user_id`;
- deleting a user in a future feature removes its completed idempotency row through `ON DELETE CASCADE` rather than leaving a replay pointer to a missing resource.

The migration is a new forward migration after `0001`; existing migrations are not rewritten.

No expiry index is added in this phase because there is no sweep query yet. Lazy reuse always addresses a single primary-key row.

## Retention and expiry

A completed claim is active for 24 hours.

The 24-hour policy is an application constant for this phase rather than another environment variable. Repository claim operations receive the TTL duration and use PostgreSQL `now()` as the authoritative clock for both expiry comparison and new `expires_at` calculation.

There is no background cleanup job in this change.

Expired rows are reclaimed lazily only when the same tenant/key is used again. Other expired rows may remain stored until a future maintenance feature adds sweeping.

## Application ports

Add a feature-specific repository port:

```ts
export interface UserCreationIdempotencyRecord {
  readonly requestFingerprint: string;
  readonly userId: string | null;
}

export type UserCreationIdempotencyClaim =
  | { readonly state: "claimed" }
  | {
      readonly state: "existing";
      readonly record: UserCreationIdempotencyRecord;
    };

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

Extend `UserUnitOfWork` with:

```ts
readonly userCreationIdempotency: UserCreationIdempotencyRepository;
```

This keeps the service independent of Drizzle/PostgreSQL details while allowing both repositories to share one transaction session.

## Claim algorithm and concurrency semantics

`DrizzleUserCreationIdempotencyRepository.claim()` uses PostgreSQL statements in this order inside the caller's transaction.

### Step 1: reclaim an expired row

Attempt an `UPDATE` on the exact `(tenant_id, key_hash)` row where `expires_at <= now()`.

If matched, replace:

- `request_fingerprint` with the new fingerprint;
- `user_id` with `NULL`;
- `claimed_at` with `now()`;
- `expires_at` with `now() + ttl`.

If the update returns a row, this transaction owns a fresh claim and returns `state: "claimed"`.

PostgreSQL row locking ensures that concurrent attempts to reclaim the same expired row serialize. A waiter rechecks the `expires_at <= now()` predicate after the winning transaction changes the row.

### Step 2: insert a new row

If no expired row was reclaimed, attempt:

```text
INSERT ... ON CONFLICT (tenant_id, key_hash) DO NOTHING RETURNING ...
```

If inserted, return `state: "claimed"`.

For two concurrent first-use requests, PostgreSQL unique-index conflict handling causes one insert to wait for the other transaction. If the first transaction commits, the waiter observes the conflict. If the first transaction rolls back, the waiter can acquire the claim.

### Step 3: read the committed active row

If insert returned no row, select the exact `(tenant_id, key_hash)` row.

Because this statement starts after any conflicting insert/update wait has completed under PostgreSQL `READ COMMITTED`, it observes the committed winner.

If the selected row is already expired due to an expiry boundary crossing between statements, retry the claim sequence with a small bounded loop. Three attempts are sufficient for this defensive path; exhausting the loop is treated as an internal invariant failure.

Return the active row as `state: "existing"`.

### Existing-row interpretation in the service

For `state: "existing"`:

1. compare `requestFingerprint` with the new fingerprint;
2. if they differ, throw the sanitized 422 mismatch error;
3. if they match but `userId` is null, throw an internal invariant error because a committed successful claim must be complete;
4. load the user with `users.findById(tenantId, userId)`;
5. if absent, throw an internal invariant error; never perform an unscoped lookup;
6. return that user as a replay.

### Fresh-claim completion

For `state: "claimed"`:

1. perform the existing tenant-local `findByEmail` check;
2. create the user;
3. call `userCreationIdempotency.complete(...)` in the same transaction;
4. `complete` updates exactly the owned tenant/key/fingerprint row where `user_id IS NULL`;
5. if exactly one row is not updated, throw an internal invariant error so the entire transaction rolls back;
6. commit both user and completed idempotency record together.

If duplicate email or another application error occurs before completion, the transaction rolls back the fresh/reclaimed claim. A retry therefore does not get stuck behind a failed request.

## CreateUserService behavior

The public call becomes conceptually:

```ts
execute(
  input: CreateUserInput,
  context: RequestContext,
  options?: { readonly idempotencyKey?: string },
): Promise<User>
```

The order is:

1. require `users:write` and obtain the authorized tenant;
2. normalize email/name;
3. if no idempotency key is supplied, execute the existing transaction flow unchanged;
4. if supplied, hash the key and canonical normalized payload outside the transaction;
5. inside one transaction, claim/replay/mismatch according to the algorithm above;
6. emit `user.created` only after a fresh create transaction succeeds;
7. do not emit `user.created` for replay.

The log event continues to include only the existing low-cardinality/correlation fields; no key/hash/fingerprint/tenant field is added.

## Drizzle adapter and composition

Add `DrizzleUserCreationIdempotencyRepository` alongside the existing user repository.

`createDatabaseAccess()` creates:

- the existing root `DrizzleUserRepository` for reads;
- a transaction unit of work containing a transaction-scoped `DrizzleUserRepository`;
- a transaction-scoped `DrizzleUserCreationIdempotencyRepository`.

The new repository may use the existing `DatabaseObserver`, but observability metadata remains low-cardinality:

- operation: `SELECT`, `INSERT`, or `UPDATE`;
- collection: `user_creation_idempotency`.

Never attach tenant ID, raw key, hashes, fingerprint, email, or user ID as DB span/metric attributes.

Composition also creates one SHA-256 digester adapter and injects it into `CreateUserService`.

## API/OpenAPI changes

Add a reusable `IdempotencyKeyHeadersSchema` based on `@hono/zod-openapi`:

```ts
z.object({
  "idempotency-key": IdempotencyKeySchema.optional(),
})
```

`createUserRoute.request.headers` references this schema. The route passes the validated optional value to `CreateUserService`.

Add a documented 422 response using `ErrorResponseSchema`.

Regenerate `openapi/openapi.json` through the existing generator. The existing contract gate and PR-only breaking-change check must remain green.

The response schema is unchanged and continues not to expose tenant ownership.

## Error handling and privacy

The following values are sensitive/high-cardinality and must not be emitted in logs, telemetry attributes, or error payloads:

- raw idempotency key;
- key hash;
- request fingerprint;
- tenant ID;
- previous normalized payload;
- prior user ID used for replay.

Validation errors may identify the `Idempotency-Key` field generically but must not echo its value.

The 422 mismatch response is deliberately indistinguishable with respect to prior payload/resource details.

## Testing strategy

### TDD order

Every behavior change starts with a failing test against the existing public boundary before production implementation.

### Unit tests

Cover:

- idempotency-key validation boundaries;
- deterministic SHA-256 adapter behavior without input leakage;
- canonical fingerprint stability after email/name normalization;
- no-key path preserves current service behavior;
- fresh claim creates and completes once;
- same fingerprint replays without create and without a second business log;
- different fingerprint returns sanitized 422;
- replay always loads through tenant-scoped `findById`;
- incomplete/corrupt committed records fail closed;
- idempotency repository calls receive no raw key.

### API tests

Cover:

- omitted key still creates normally;
- invalid key returns 400;
- same key/same payload returns 201 with the same user ID;
- same key/different normalized payload returns 422;
- equivalent raw inputs that normalize to the same payload replay successfully;
- client-provided tenant fields remain ignored and cannot alter key scope;
- same raw key can be used independently by two tenant principals;
- error bodies never echo the key.

### PostgreSQL integration tests

Cover real adapter behavior:

- ledger schema/constraints;
- raw key is not stored;
- same tenant/key serializes concurrent claims;
- two concurrent full create operations using the same tenant/key/payload commit exactly one user and replay that user to both callers;
- same tenant/key/different payload cannot create a second user;
- same key in separate tenants is independent;
- expired rows can be reclaimed;
- failed create transaction rolls back its claim;
- completed rows reference the created user;
- observer attributes remain low-cardinality and contain none of the prohibited values.

Concurrency tests must use separate database transactions/connections rather than only sequential repository calls.

### E2E

Extend the real `bun run start` production-entrypoint test:

1. start an authenticated tenant server against migrated PostgreSQL;
2. send `POST /users` with an idempotency key and payload;
3. repeat the identical request with the same key;
4. require both responses to be 201 with the same user ID;
5. verify a changed payload with that key returns 422;
6. fetch the user successfully;
7. retain graceful SIGTERM assertions.

Existing tenant A/B isolation coverage remains intact.

### Contract and migration gates

- drizzle migration verification must stay green;
- committed OpenAPI snapshot must match runtime generation;
- Redocly validation must pass;
- oasdiff PR comparison must pass;
- quality, coverage, contract, integration, e2e, and required CI jobs must all pass.

## Migration safety

The new table contains no backfill requirement because it represents behavior that did not exist before this change.

Do not modify `0000_initial.sql` or `0001_mean_barracuda.sql`.

Generate the next migration with the repository-pinned Bun/drizzle-kit toolchain and review generated metadata before committing.

## Documentation

Update README/architecture/contributor-facing material to explain:

- `Idempotency-Key` is optional;
- its scope is tenant-local `POST /users`;
- same-key/same-normalized-payload replays;
- same-key/different-payload returns 422;
- retention is 24 hours with lazy reclaim;
- raw keys are hashed before persistence;
- no Redis or background cleanup service is required in this phase.

## Acceptance criteria

The change is complete only when all of the following are true:

- `POST /users` works exactly as before when no key is supplied;
- a same-tenant concurrent duplicate with one key/payload creates one user total;
- repeated same-key/same-normalized-payload calls return the same user ID;
- same-key/different-payload returns sanitized 422;
- same raw key remains independent across tenants;
- expired keys can be reused after 24 hours;
- failed transactions do not leave committed incomplete claims;
- raw keys are absent from persistence, logs, telemetry, context, and errors;
- no unscoped user lookup is introduced;
- no new external infrastructure dependency is introduced;
- existing migrations remain immutable;
- final branch CI, PR CI including OpenAPI breaking comparison, and post-merge main CI are green.