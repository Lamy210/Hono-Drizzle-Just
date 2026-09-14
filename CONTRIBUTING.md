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

Do not commit local `.env` files, credentials, tokens, or generated secrets.

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
- Database migrations are applied before integration tests.

Before opening a pull request, run:

```bash
just check
just test-all
```

CI additionally verifies committed migration history and installs dependencies with `bun ci`.

## Architecture boundaries

Preserve the dependency direction documented in `docs/architecture.md`.

In particular:

- `core` must not depend on Hono, Drizzle, Zod, PostgreSQL, or OpenTelemetry SDK types.
- API schemas and database schemas remain separate contracts.
- Application services depend on ports such as repositories and transaction managers, not concrete infrastructure adapters.
- External HTTP calls go through the application-owned `HttpClient` abstraction.
- Authentication provider data is normalized into the provider-neutral `Principal` boundary.
- Telemetry attributes must remain low-cardinality and must not contain SQL bind values, credentials, email addresses, UUIDs, or other sensitive/request-specific values.

## Database changes

Schema changes require committed Drizzle migration history.

```bash
just db-generate
just db-check
just db-verify
```

Review generated SQL and metadata before committing them. Do not replace a migration with `drizzle-kit push` in CI or deployment, and do not run migrations implicitly during API startup.

## Dependency and toolchain changes

When changing Bun packages, commit `package.json` and the resulting `bun.lock` together. CI requires the lockfile and uses `bun ci`.

Changes to the repository Bun runtime update `.bun-version` explicitly. Third-party GitHub Actions remain pinned to immutable full commit SHAs; human-readable version comments are documentation only.

Renovate policy is documented in `docs/dependency-automation.md`. Renovate pull requests still require normal review and CI; auto-merge is disabled by default.

## Pull requests

Use the pull request template and explain the problem, design choice, and verification evidence. A pull request should be ready to merge only when:

- the change is focused and documented where needed;
- new or changed behavior has regression coverage;
- quality and integration CI are green;
- schema changes include reviewed migrations;
- dependency changes include the lockfile;
- no secrets, raw credentials, PII, or high-cardinality telemetry were introduced;
- review conversations are resolved.

Squash merge is preferred so each pull request lands as one coherent change on `main`.

## Security reports

Do not disclose suspected vulnerabilities, credentials, or exploit details in a public issue or pull request. Follow `SECURITY.md` for the private reporting path.
