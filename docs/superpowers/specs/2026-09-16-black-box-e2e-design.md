# Black-box E2E gate design

Date: 2026-09-16
Status: approved design
Scope: Hono-Drizzle-Just template test architecture and CI

## Context

The repository already has four distinct verification layers: unit tests, in-process Hono API tests, PostgreSQL integration tests, and CI quality/coverage gates. The production entrypoint in `src/app/server.ts` is not currently exercised as a real child process. Existing integration tests call Drizzle repositories, transactions, factories, and composition directly inside the test process, so they do not prove that the production server entrypoint can bind a TCP port, build the production dependency graph, become ready against PostgreSQL, serve real HTTP, and terminate cleanly through the SIGTERM shutdown path.

The new E2E layer must close that gap without duplicating the detailed assertions already owned by unit, API, and integration tests.

## Goals

1. Start the real production entrypoint with `bun run start` in a child process.
2. Use a real TCP listener and a real PostgreSQL service with committed migrations applied.
3. Treat `/health/ready` returning HTTP 200 as the startup success condition, rather than treating an open TCP port as sufficient.
4. Exercise one critical end-to-end business flow over real HTTP: create a user and fetch the created user.
5. Verify liveness and readiness over the real network boundary.
6. Send SIGTERM to the production process and verify clean bounded termination through the existing graceful-shutdown path.
7. Add an independent required GitHub Actions `e2e` job and include it in the aggregate `required` gate.
8. Keep external dependencies and test-only production behavior to a minimum.

## Non-goals

- Re-testing every validation, 404, conflict, request-body-limit, tracing, or retry edge case in E2E.
- Replacing `tests/api` or `tests/integration`.
- Building or testing a Docker image in this change.
- Adding test-only HTTP endpoints.
- Changing production configuration semantics solely for test convenience.
- Turning E2E into a large browser-style suite.

## Test-layer responsibilities

The intended boundaries are:

- `tests/unit`: pure or narrowly isolated behavior.
- `tests/api`: in-process Hono request/response contracts and HTTP edge cases.
- `tests/integration`: Drizzle, PostgreSQL, transactions, factories, and persistence adapter behavior.
- `tests/e2e`: real production process wiring across TCP, Hono, application services, persistence, PostgreSQL, and process lifecycle.

The E2E suite should stay broad and shallow. Detailed behavior remains in the faster lower-level suites.

## E2E process model

The test runner launches the production entrypoint as a child process using the public application command, not by importing `createApp()` or `server.ts` into the test process.

The child receives an explicit environment containing at least:

- `NODE_ENV=test`
- `DATABASE_URL=<test PostgreSQL URL>`
- `PORT=<reserved dynamic port>`
- `OTEL_ENABLED=false`

Other production defaults remain unchanged unless a test-specific value is necessary for determinism.

The child process must use piped stdout/stderr so the E2E harness can retain logs for diagnostics and assert lifecycle events without relying on GitHub Actions log scraping.

## Port allocation

The production config continues to require `PORT` in the valid user-facing range 1-65535. The E2E test will not change production configuration to allow `PORT=0`.

A test helper obtains a candidate free port by binding a temporary local server to `127.0.0.1:0`, recording the OS-assigned port, closing the temporary listener, then passing that port to the production child.

There is an unavoidable small race between releasing the temporary listener and the child binding the port. The first implementation will keep this simple and fail with captured child logs if the race occurs. A narrow retry for `EADDRINUSE` may be added later only if CI evidence demonstrates real flakiness.

## Startup readiness

The harness must not infer readiness from process existence or from a successful TCP connection.

After spawning the child, the harness repeatedly requests `GET /health/ready` against `127.0.0.1:<port>` using a bounded deadline and short retry interval. Startup succeeds only when the endpoint returns HTTP 200. A 503 means the server is alive but a critical dependency such as PostgreSQL is not ready yet and should be retried until the deadline.

If the child exits before readiness, the test fails immediately and includes captured stdout/stderr. If the startup deadline expires, the test fails with the most recent HTTP/error state plus captured child logs.

## Critical E2E scenario

Once ready, the suite verifies:

1. `GET /health/live` returns 200 and the expected liveness payload.
2. `GET /health/ready` returns 200 and reports ready status.
3. `POST /users` with a unique random email returns 201 and a valid user response.
4. The returned user ID is then used with `GET /users/{id}`.
5. The GET response returns 200 and matches the persisted user identity from the POST response.

This flow proves the connected path from a real TCP request through Bun server startup, Hono routing/validation, production dependency composition, service logic, transaction/repository code, PostgreSQL, and back to the HTTP response.

The E2E suite intentionally does not duplicate the full negative-path matrix already covered elsewhere.

## Database lifecycle

The E2E CI job owns its own PostgreSQL service, isolated from the existing integration job. Before starting the application, `ci:e2e` applies committed migrations to that database.

The E2E test assumes migration application has already succeeded; it does not invoke migration tooling inside test code. This keeps the test harness focused on application behavior while the public `ci:e2e` command defines the required setup sequence.

## Shutdown verification

After the HTTP scenario, the harness sends SIGTERM to the child process. The production signal handler must invoke the existing `GracefulShutdownCoordinator`.

Success requires:

- the child exits within a bounded shutdown timeout,
- the process exits successfully rather than being force-killed by the harness,
- captured logs include `server.stopping`,
- captured logs include `server.stopped`.

The test harness always owns final cleanup. In a `finally` path it checks whether the child is still alive and terminates it so failures do not leave orphaned processes on local machines or CI runners.

A forced cleanup kill is a harness safety mechanism and does not count as a successful graceful-shutdown assertion.

## Public commands

Add the following commands:

- `bun run test:e2e` -> execute `tests/e2e` only.
- `bun run ci:e2e` -> apply committed migrations, then execute E2E.
- `just test-e2e` -> public Just wrapper for E2E execution.

The existing full local CI contract remains authoritative. `bun run ci` / `just ci` must include the E2E gate in addition to quality, coverage, and PostgreSQL integration checks.

The exact composition should avoid re-running migrations unnecessarily where a single local database is shared, but correctness and semantic clarity take priority over micro-optimizing command duration.

## GitHub Actions

Add an independent `e2e` job with:

- `ubuntu-latest`,
- a bounded job timeout,
- a dedicated `postgres:18-alpine` service,
- the same Bun version pinning/verification conventions as existing jobs,
- `DATABASE_URL` pointing at the E2E PostgreSQL service,
- dependency installation with `bun ci`,
- execution through `bun run ci:e2e`.

The aggregate gate becomes:

`needs: [quality, coverage, integration, e2e]`

and explicitly verifies all four results equal `success`.

The E2E job remains separate from `integration` so a production-startup or lifecycle regression is distinguishable from a repository/transaction persistence regression.

## Tooling contract tests

Extend repository-owned tooling contract coverage so CI wiring cannot silently drift. Tests should verify at minimum:

- `package.json` contains `test:e2e` and `ci:e2e`,
- the full `ci` command includes the E2E gate,
- `justfile` exposes `test-e2e`,
- `.github/workflows/ci.yml` defines an `e2e` job,
- the E2E job executes `bun run ci:e2e`,
- `required.needs` includes `e2e`,
- the aggregate verification checks the E2E result.

These tests protect command/CI semantics; they do not replace the real E2E test.

## Failure diagnostics

The E2E harness should make failures actionable. On startup, HTTP, or shutdown failure it should surface captured child stdout/stderr in the thrown assertion/error context. Logs must not be modified to expose secrets; existing structured logger redaction/safety rules remain authoritative.

The harness should use bounded polling and bounded process-exit waits. No test path may wait indefinitely for readiness or shutdown.

## Security and isolation

- Bind test traffic to loopback only.
- Use CI-only PostgreSQL credentials already scoped to the ephemeral service.
- Do not add secrets or external network dependencies.
- Disable OTLP export in E2E by setting `OTEL_ENABLED=false`.
- Do not create test-only bypasses in production authorization/configuration behavior.

## TDD and verification strategy

Implementation follows TDD in two layers.

First, add tooling contract assertions that fail because the E2E commands/job/required wiring do not exist. Confirm this RED state in CI before adding the command wiring.

Second, add the real black-box E2E scenario and exercise it against the actual CI PostgreSQL service. Any failures discovered in the harness or production entrypoint are fixed without weakening the test boundary.

The change is complete only when the exact final branch head passes `quality`, `coverage`, `integration`, `e2e`, and `required`; the PR-triggered run for the same head passes all five; the PR is squash-merged with the validated expected head SHA; and the resulting merge commit on `main` also passes all five jobs.

## Acceptance criteria

- Production `bun run start` is launched as a child process by the E2E suite.
- Startup is gated on HTTP 200 from `/health/ready`.
- Real network requests successfully cover liveness, readiness, user creation, and user retrieval.
- SIGTERM causes bounded successful process exit and emits both stopping/stopped lifecycle log events.
- Failure paths clean up child processes.
- E2E uses a real migrated PostgreSQL service.
- `test:e2e`, `ci:e2e`, and `just test-e2e` are available.
- The independent Actions `e2e` job is mandatory through `required`.
- Existing unit/API/integration test responsibilities remain intact.
- No new runtime or test dependency is required unless implementation evidence proves the standard Bun APIs are insufficient.
