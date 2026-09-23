# Contributing

Thanks for contributing to Hono-Drizzle-Just. This repository is a reusable backend template, so changes should preserve clear boundaries, reproducible builds, and safe defaults for downstream users.

## Development setup

Use the exact Bun version declared in `.bun-version`. `package.json#engines.bun` is the compatibility floor, while `.bun-version` is the repository toolchain target used by CI.

Prerequisites:

- Bun matching `.bun-version`
- PostgreSQL 18 for the default integration environment
- `just`
- Docker/Compose for the documented local database workflow

```bash
cp .env.example .env
bun install
just db-up
just db-migrate
just check
```

Do not commit local `.env` files, credentials, tokens, or generated secrets. The built-in static bearer resolver is a development/test adapter only; never configure it as production authentication, and never commit a real bearer token into `.env.example`, tests, documentation, or fixtures.

## Branches and change scope

Create a focused branch from current `main`. Prefer descriptive prefixes such as:

- `feat/` for new behavior
- `fix/` for bug fixes
- `refactor/` for behavior-preserving restructuring
- `test/` for test-only changes
- `docs/` for documentation
- `chore/` for tooling and repository maintenance

Keep pull requests narrowly scoped. Unrelated refactors, dependency upgrades, schema changes, and feature work should normally be separate pull requests.

## Development workflow

Behavior changes follow test-driven development: add the smallest failing test, confirm the expected failure, implement the minimum change, then run the complete relevant verification suite.

The repository's testing policy is intentional:

- Service and domain tests do not require PostgreSQL.
- Repository and transaction integration tests use a real PostgreSQL database and do not mock Drizzle.
- API tests use Hono's in-process request API.
- Black-box E2E tests launch the public `bun run start` production entrypoint, communicate over loopback TCP, use a real PostgreSQL database, and verify process lifecycle behavior. Tenant authorization E2E uses sequential tenant A/B production processes over the same database rather than a test-only server path.
- Database migrations are applied before integration and standalone E2E CI runs.
- The committed `openapi/openapi.json` artifact is generated from the same `createApp()` runtime document served at `/openapi.json`; it is not maintained by hand.

Keep E2E broad and shallow. Validation/error matrices belong in `tests/api`; repository, transaction, and persistence details belong in `tests/integration`. `tests/e2e` proves that the production process wiring works end to end rather than duplicating those lower-level suites.

Verification is split into stable layers:

- `just check-fast` runs lint, typecheck, and unit/API tests. It does not require PostgreSQL and is intended for the normal edit loop.
- `just check` adds committed migration-history verification and matches the GitHub Actions `quality` job.
- `just openapi-verify` regenerates the OpenAPI document in memory, rejects snapshot drift, validates OpenAPI 3.1 with Redocly's specification rules, and validates the document with pinned oasdiff tooling. It does not require PostgreSQL.
- `just coverage` runs unit/API tests with Bun's native coverage gate. The repository requires at least 80% line coverage and 75% function coverage and generates `coverage/lcov.info`.
- `just test-e2e` runs the production-process E2E suite against the configured, already-migrated `DATABASE_URL`. Use `bun run ci:e2e` when you want the standalone migration-plus-E2E sequence.
- `just ci` composes `just check`, the OpenAPI contract gate, the coverage gate, committed migration application, the PostgreSQL integration suite, and black-box E2E. With the same database environment, this is the local full-CI equivalent.

Before opening a pull request, start PostgreSQL and run:

```bash
just ci
```

For a DB-free preflight, run `just check`, `just openapi-verify`, and `just coverage` separately.

Coverage is intentionally repository-owned: thresholds and reporters live in `bunfig.toml`, and no external coverage SaaS is required. Bun reports coverage for files loaded by the selected test run; a source file that is never imported may not appear in the report. Treat the aggregate percentage as a regression gate for executed code, not as proof that every source file was measured. Test files themselves are excluded from the coverage calculation.

GitHub Actions installs dependencies with `bun ci`, runs `bun run check` in the `quality` job, runs `bun run test:coverage` in an independent `coverage` job, runs `bun run openapi:contract` in the DB-free `contract` job, runs migration application plus persistence tests in the parallel `integration` job, and runs `bun run ci:e2e` in a separate PostgreSQL-backed `e2e` job. The aggregate `required` job succeeds only when all five component jobs succeed.

## OpenAPI contract changes

`openapi/openapi.json` is a reviewed public API artifact. When a route, request schema, response schema, status code, or other documented contract changes, run:

```bash
just openapi-generate
just openapi-verify
```

Commit the generated `openapi/openapi.json` change together with the source change that caused it. Do not hand-edit the snapshot to make CI green; `openapi:verify` compares it against a fresh document generated through `createApp()`.

The `contract` CI job validates the snapshot with Redocly and oasdiff. On pull requests, oasdiff also compares the proposed snapshot with the base commit and fails on changes categorized as breaking errors. The oasdiff binary is downloaded from its pinned release and verified against repository-owned SHA-256 values before use. The default workflow does not upload the OpenAPI description to an external review service.

If an intentional breaking API change is required, make that decision explicit in the pull request rather than weakening or bypassing the gate. Changing the compatibility policy is a separate governance change.

## Architecture boundaries

Preserve the dependency direction documented in `docs/architecture.md`.

In particular:

- `core` must not depend on Hono, Drizzle, Zod, PostgreSQL, or OpenTelemetry SDK types.
- API schemas and database schemas remain separate contracts.
- Application services depend on ports such as repositories and transaction managers, not concrete infrastructure adapters.
- External HTTP calls go through the application-owned `HttpClient` abstraction.
- Authentication provider data is normalized into the provider-neutral `Principal` boundary.
- Authorization stays in the application layer: protected use cases derive tenant ownership only from `RequestContext.principal`, and authorization failures must not disclose required scopes, other tenant IDs, or row existence.
- Tenant-owned repositories must keep tenant ID in their public method signatures and SQL predicates; do not add an unscoped user lookup as a convenience method.
- Mutable tenant-owned sample resources must preserve ETag semantics: emit a strong ETag for an individual representation, support `If-None-Match` weak-comparison revalidation on GET after the normal authenticated tenant-scoped lookup, and require `If-Match` for PATCH and DELETE. Keep PATCH version matching plus version increment in the same database UPDATE, and DELETE version matching in the same database DELETE. Do not replace either write path with an application read-then-write check or an unscoped existence probe.
- Idempotency handling must remain tenant-scoped and transactional. Hash raw keys before persistence, never add raw keys/hashes/fingerprints to logs or telemetry, and replay users only through tenant-scoped repository methods. The current user-create ledger is pointer-only: same-fingerprint replay resolves the current tenant-local representation for the original user ID. Do not add response snapshots or mutable user PII to the ledger without an explicit retention/privacy/versioning design.
- Transaction retry is opt-in. Use `retry: "safe"` only when the complete transaction callback can be replayed after rollback without duplicating external-service calls, message publication, filesystem writes, or other non-transactional business side effects. Do not broaden retryable SQLSTATEs casually; `23505` remains a domain conflict unless a specific use case proves replay is correct.
- Successful user mutation business logs are application-owned and emitted only after persistence succeeds. Keep the sample event context to `userId`, `requestId`, and `traceId`; do not add email, name, tenant ID, payloads, credentials, idempotency keys/hashes/fingerprints, or database diagnostics. Failed mutations and idempotent create replays must not emit successful mutation events.
- Telemetry attributes must remain low-cardinality and must not contain SQL bind values, credentials, email addresses, UUIDs, or other sensitive/request-specific values.

## Database changes

Schema changes require committed Drizzle migration history.

```bash
just db-generate
just db-check
just db-verify
```

Review generated SQL and metadata before committing them. Do not replace a migration with `drizzle-kit push` in CI or deployment, and do not run migrations implicitly during API startup.

For feature migrations such as the user-creation idempotency ledger, preserve existing migration files and add a new forward migration. Review tenant scoping, uniqueness/foreign-key constraints, rollback behavior, and real PostgreSQL concurrency tests together with the generated migration.

## Dependency and toolchain changes

When changing Bun packages, commit `package.json` and the resulting `bun.lock` together. CI requires the lockfile and uses `bun ci`.

Changes to the repository Bun runtime update `.bun-version` explicitly. Third-party GitHub Actions remain pinned to immutable full commit SHAs; human-readable version comments are documentation only.

Renovate policy is documented in `docs/dependency-automation.md`. Renovate pull requests still require normal review and CI; auto-merge is disabled by default.

## Pull requests

Use the pull request template and explain the problem, design choice, and verification evidence. A pull request should be ready to merge only when:

- the change is focused and documented where needed;
- new or changed behavior has regression coverage;
- `just ci` passes locally, or any environment-specific exception is explained;
- quality, coverage, contract, integration, E2E, and required CI are green;
- API contract changes include the generated `openapi/openapi.json` diff and have been reviewed for compatibility;
- schema changes include reviewed migrations;
- dependency changes include the lockfile;
- no secrets, raw credentials, PII, or high-cardinality telemetry were introduced;
- review conversations are resolved.

Squash merge is preferred so each pull request lands as one coherent change on `main`.

## Security reports

Do not disclose suspected vulnerabilities, credentials, or exploit details in a public issue or pull request. Follow `SECURITY.md` for the private reporting path.
