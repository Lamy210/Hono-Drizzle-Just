# Black-box E2E gate design

Date: 2026-09-16
Status: approved design
Scope: Hono-Drizzle-Just template test architecture and CI

## Context

The repository already has unit tests, in-process Hono API tests, PostgreSQL integration tests, and CI quality/coverage gates. The production entrypoint in `src/app/server.ts` is not currently exercised as a real child process. Existing integration tests call Drizzle repositories, transactions, factories, and composition directly inside the test process, so they do not prove that the production server can bind a real TCP port, construct the production dependency graph, become ready against PostgreSQL, serve real HTTP, and terminate through the SIGTERM shutdown path.

The new E2E layer closes that gap without duplicating detailed assertions owned by lower-level suites.

## Goals

1. Start the real production entrypoint with `bun run start` in a child process.
2. Use a real TCP listener and a real PostgreSQL service with committed migrations applied.
3. Treat `/health/ready` returning HTTP 200 as startup success, not merely an open TCP port.
4. Exercise one critical business flow over real HTTP: create a user and fetch that user.
5. Verify liveness and readiness over the real network boundary.
6. Send SIGTERM and verify clean bounded termination through the existing graceful-shutdown path.
7. Add an independent required GitHub Actions `e2e` job.
8. Avoid new dependencies and test-only production behavior unless implementation evidence proves they are necessary.

## Non-goals

- Re-testing every validation, 404, conflict, body-limit, tracing, or retry edge case in E2E.
- Replacing `tests/api` or `tests/integration`.
- Building or testing a Docker image in this change.
- Adding test-only HTTP endpoints.
- Changing production configuration solely for test convenience.
- Turning E2E into a large browser-style suite.

## Test-layer responsibilities

- `tests/unit`: pure or narrowly isolated behavior.
- `tests/api`: in-process Hono request/response contracts and HTTP edge cases.
- `tests/integration`: Drizzle, PostgreSQL, transactions, factories, and persistence adapter behavior.
- `tests/e2e`: real production process wiring across TCP, Hono, application services, persistence, PostgreSQL, and process lifecycle.

The E2E suite stays broad and shallow. Detailed behavior remains in faster lower-level suites.

## Process model

The E2E runner launches the public application command as a child process. It does not import `createApp()` or `server.ts` into the test process.

The child receives an explicit environment containing at least:

- `NODE_ENV=test`
- `DATABASE_URL=<test PostgreSQL URL>`
- `PORT=<reserved dynamic port>`
- `OTEL_ENABLED=false`

The child uses piped stdout/stderr so the harness can retain diagnostics and assert lifecycle log events without relying on GitHub Actions log scraping.

## Port allocation

Production configuration continues to require `PORT` in the normal 1-65535 range. E2E will not change config semantics to allow `PORT=0`.

A test helper binds a temporary loopback server to `127.0.0.1:0`, records the OS-assigned port, closes the temporary listener, then passes the port to the production child.

There is a small unavoidable race between releasing the temporary listener and the child binding the port. The first implementation will fail with captured logs if that race occurs. A narrow `EADDRINUSE` retry may be added later only if CI evidence demonstrates actual flakiness.

## Startup readiness

After spawning the child, the harness repeatedly requests `GET /health/ready` against `127.0.0.1:<port>` with a bounded deadline and short retry interval.

Startup succeeds only when the endpoint returns HTTP 200. HTTP 503 means the process is serving but a critical dependency such as PostgreSQL is not ready yet, so polling continues until the deadline.

If the child exits before readiness, the test fails immediately with captured stdout/stderr. If the deadline expires, the failure includes the most recent HTTP/error state and captured child logs.

## Critical E2E scenario

Once ready, the suite verifies:

1. `GET /health/live` returns 200 with the expected liveness payload.
2. `GET /health/ready` returns 200 and ready status.
3. `POST /users` with a unique random email returns 201 and a valid user response.
4. The returned ID is used with `GET /users/{id}`.
5. The GET returns 200 and matches the identity created by POST.

This proves the connected path from real TCP through Bun server startup, Hono routing/validation, production dependency composition, application services, transaction/repository code, PostgreSQL, and back to the HTTP response.

Negative-path matrices remain in unit/API/integration suites.

## Database lifecycle

The Actions `e2e` job owns its own PostgreSQL service, isolated from the existing integration job.

The public standalone command is exactly:

`ci:e2e = db:migrate -> test:e2e`

The E2E test code itself does not invoke migration tooling. It assumes the schema is already migrated.

For the existing full local CI command, migration must not be repeated unnecessarily. The exact full sequence is:

`ci = check -> test:coverage -> ci:integration -> test:e2e`

`ci:integration` already performs `db:migrate` before integration tests, so the following `test:e2e` reuses that migrated database. This keeps standalone `ci:e2e` correct while avoiding a second migration pass in full local CI.

## Shutdown verification

After the HTTP scenario, the harness sends SIGTERM to the child process. The production signal handler must invoke the existing `GracefulShutdownCoordinator`.

Success requires:

- the child exits within a bounded shutdown timeout,
- awaiting `child.exited` yields exit code `0`,
- the process was not force-killed by the harness,
- captured logs include `server.stopping`,
- captured logs include `server.stopped`.

The harness always owns final cleanup. In `finally`, if the child is still alive, it terminates the process so failures cannot leave orphaned local or CI processes. Forced cleanup is a safety mechanism and never satisfies the graceful-shutdown assertion.

## Public commands

Add:

- `bun run test:e2e` -> run `tests/e2e` only.
- `bun run ci:e2e` -> run `db:migrate`, then `test:e2e`.
- `just test-e2e` -> public Just wrapper for E2E execution.

The existing `bun run ci` / `just ci` contract remains the local full-CI equivalent and follows the exact sequence defined above.

## GitHub Actions

Add an independent `e2e` job with:

- `ubuntu-latest`,
- a bounded job timeout,
- dedicated `postgres:18-alpine`,
- existing Bun version pinning and verification conventions,
- `DATABASE_URL` for the E2E database,
- `bun ci`,
- `bun run ci:e2e`.

The aggregate gate becomes:

`needs: [quality, coverage, integration, e2e]`

and explicitly checks all four results equal `success`.

Keeping `e2e` separate from `integration` makes production-startup/lifecycle failures distinguishable from repository/transaction persistence failures.

## Tooling contract tests

Repository-owned contract tests must verify at minimum:

- `package.json` contains `test:e2e` and `ci:e2e`,
- `ci:e2e` includes migration followed by E2E,
- full `ci` includes E2E without redundantly calling `ci:e2e`,
- `justfile` exposes `test-e2e`,
- `.github/workflows/ci.yml` defines `e2e`,
- the E2E job executes `bun run ci:e2e`,
- `required.needs` includes `e2e`,
- aggregate verification checks the E2E result.

These tests protect command/CI semantics; they do not replace the real black-box test.

## Failure diagnostics

Startup, HTTP, and shutdown failures must surface captured child stdout/stderr. Existing logger safety/redaction rules remain authoritative; the harness must not intentionally expose secrets.

Readiness polling and process-exit waits are bounded. No test path may wait indefinitely.

## Security and isolation

- Bind test traffic to loopback only.
- Use ephemeral CI PostgreSQL credentials scoped to the job service.
- Add no secrets or external network dependencies.
- Set `OTEL_ENABLED=false` so E2E never attempts an OTLP export.
- Do not add test-only authorization or configuration bypasses.

## TDD and verification strategy

Implementation follows TDD in two layers.

First, add tooling contract assertions that fail because the E2E commands, job, and aggregate wiring do not exist. Confirm this RED state in CI before adding command/workflow wiring.

Second, add the real black-box E2E scenario and run it against the CI PostgreSQL service. Failures discovered in the harness or production entrypoint are fixed without weakening the black-box boundary.

Completion requires the exact final branch head, the PR-triggered run for that same head, and the resulting squash-merge commit on `main` all to pass:

- `quality`
- `coverage`
- `integration`
- `e2e`
- `required`

## Acceptance criteria

- `bun run start` is launched as a child process by the E2E suite.
- Startup is gated on HTTP 200 from `/health/ready`.
- Real network requests cover liveness, readiness, user creation, and user retrieval.
- SIGTERM leads to bounded exit code `0` and both stopping/stopped lifecycle events.
- Failure paths clean up child processes.
- E2E uses a real migrated PostgreSQL service.
- `test:e2e`, `ci:e2e`, and `just test-e2e` exist.
- Full local `ci` runs E2E after the already-migrated integration phase without a redundant migration call.
- The independent Actions `e2e` job is mandatory through `required`.
- Existing lower-level test responsibilities remain intact.
- No new runtime or test dependency is added unless standard Bun APIs prove insufficient.
