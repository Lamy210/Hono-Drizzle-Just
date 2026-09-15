# Black-box E2E Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a required black-box E2E verification layer that launches the real Bun production entrypoint, exercises a critical HTTP/PostgreSQL flow, and proves graceful SIGTERM shutdown.

**Architecture:** Keep the existing unit, in-process API, and PostgreSQL integration layers unchanged. Add one broad-and-shallow E2E scenario under `tests/e2e` that chooses an ephemeral loopback port, spawns `bun run start` with the CI PostgreSQL URL, waits for `/health/ready`, performs liveness/readiness plus create/fetch user requests over TCP, then sends SIGTERM and requires exit code 0 plus lifecycle logs. Add a separate PostgreSQL-backed Actions `e2e` job and include it in the aggregate `required` gate.

**Tech Stack:** Bun 1.4.2, Bun test runner, `Bun.spawn`, Node-compatible `node:net`, Hono 4.13.7, Drizzle ORM 0.45.2, PostgreSQL 18, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-16-black-box-e2e-design.md`

## Global Constraints

- Launch the public production command `bun run start`; do not import `src/app/server.ts` into the test process.
- Use a real loopback TCP port and a real migrated PostgreSQL database.
- Startup success is HTTP 200 from `/health/ready`, not merely a bound port.
- Exercise only the critical happy path plus lifecycle; do not duplicate the negative-path matrix owned by lower-level tests.
- Set `OTEL_ENABLED=false` and do not add external network dependencies or secrets.
- Do not change production config semantics to allow `PORT=0`; allocate a free user-space port in the test harness instead.
- `ci:e2e` applies migrations before E2E. The full `ci` command must not apply migrations twice: it runs `ci:integration` first, then `test:e2e` against the already-migrated database.
- SIGTERM success requires bounded exit, actual exit code `0`, and captured `server.stopping` plus `server.stopped` log messages.
- Failure cleanup must terminate any still-running child process so local and CI runs cannot leak orphaned servers.
- No new runtime or test dependency unless Bun standard APIs prove insufficient.

---

### Task 1: Protect the E2E command and CI contract with a failing tooling test

**Files:**
- Create: `tests/unit/tooling/e2e-gate.test.ts`

**Interfaces:**
- Consumes: repository text files `package.json`, `justfile`, `.github/workflows/ci.yml`.
- Produces: repository-owned assertions for exact E2E script composition and required-job wiring.

- [ ] **Step 1: Add the failing tooling contract test**

Create `tests/unit/tooling/e2e-gate.test.ts`:

```ts
import { expect, test } from "bun:test";

interface PackageJson {
  readonly scripts?: Record<string, string>;
}

const root = new URL("../../../", import.meta.url);

async function readText(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text();
}

test("package scripts expose standalone and full-CI E2E commands", async () => {
  const packageJson = JSON.parse(await readText("package.json")) as PackageJson;

  expect(packageJson.scripts?.["test:e2e"]).toBe("bun test tests/e2e");
  expect(packageJson.scripts?.["ci:e2e"]).toBe("bun run db:migrate && bun run test:e2e");
  expect(packageJson.scripts?.ci).toBe(
    "bun run check && bun run test:coverage && bun run ci:integration && bun run test:e2e",
  );
});

test("just exposes the E2E test command", async () => {
  const justfile = await readText("justfile");

  expect(justfile).toContain(
    "test-e2e:\n  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run test:e2e\n",
  );
});

test("GitHub Actions makes E2E an independent required job", async () => {
  const workflow = await readText(".github/workflows/ci.yml");

  expect(workflow).toContain("  e2e:\n");
  expect(workflow).toContain("- run: bun run ci:e2e\n");
  expect(workflow).toContain("needs: [quality, integration, coverage, e2e]");
  expect(workflow).toContain("E2E_RESULT: ${{ needs.e2e.result }}");
  expect(workflow).toContain('test "$E2E_RESULT" = "success"');
});
```

- [ ] **Step 2: Commit only the RED contract test**

```bash
git add tests/unit/tooling/e2e-gate.test.ts
git commit -m "test: define black-box E2E gate contract"
```

- [ ] **Step 3: Verify the intended RED state in branch CI**

Expected `quality` failure: the new tooling test fails because `test:e2e`, `ci:e2e`, `just test-e2e`, the Actions `e2e` job, and `required` E2E aggregation do not exist yet. Existing migration/lint/typecheck steps must remain green before the unit assertion failure.

---

### Task 2: Add the real production-process E2E scenario

**Files:**
- Create: `tests/e2e/helpers/free-port.ts`
- Create: `tests/e2e/server.e2e.ts`

**Interfaces:**
- Consumes: `DATABASE_URL`, public `bun run start`, `/health/live`, `/health/ready`, `POST /users`, `GET /users/{id}`.
- Produces: `getFreeLoopbackPort(): Promise<number>` and one black-box E2E test owning startup, diagnostics, SIGTERM shutdown, and forced cleanup.

- [ ] **Step 1: Add the free-port helper**

Create `tests/e2e/helpers/free-port.ts`:

```ts
import { createServer } from "node:net";

export async function getFreeLoopbackPort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate an IPv4 loopback port");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}
```

- [ ] **Step 2: Add exact process/readiness/diagnostic helpers to the E2E file**

Create `tests/e2e/server.e2e.ts` beginning with:

```ts
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getFreeLoopbackPort } from "./helpers/free-port";

const root = new URL("../../", import.meta.url);
const startupTimeoutMs = 10_000;
const shutdownTimeoutMs = 5_000;

interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: string;
}

function requiredDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for E2E tests");
  return url;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }),
  ]);
}

async function waitUntilReady(baseUrl: string, child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastState = "not attempted";

  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(100).then(() => ({ kind: "tick" as const })),
    ]);

    if (outcome.kind === "exit") {
      throw new Error(`server exited before readiness with code ${outcome.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(500),
      });
      lastState = `HTTP ${response.status}`;
      if (response.status === 200) return;
    } catch (error) {
      lastState = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`server did not become ready: ${lastState}`);
}

function failureWithLogs(error: unknown, stdout: string, stderr: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${message}\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`, {
    cause: error,
  });
}
```

- [ ] **Step 3: Write the black-box test around the real child process**

Use the public production command and start draining output immediately:

```ts
test("production server serves a persisted user flow and shuts down on SIGTERM", async () => {
  const port = await getFreeLoopbackPort();
  const child = Bun.spawn({
    cmd: ["bun", "run", "start"],
    cwd: fileURLToPath(root),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: requiredDatabaseUrl(),
      PORT: String(port),
      OTEL_ENABLED: "false",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = child.stdout.text();
  const stderrPromise = child.stderr.text();
  const baseUrl = `http://127.0.0.1:${port}`;
  let gracefulShutdownVerified = false;

  try {
    await waitUntilReady(baseUrl, child);

    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok" });

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect((await ready.json() as { status: string }).status).toBe("ready");

    const email = `e2e-${crypto.randomUUID()}@example.com`;
    const name = "E2E User";
    const createdResponse = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as UserResponse;
    expect(created.email).toBe(email);
    expect(created.name).toBe(name);
    expect(created.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);

    const fetchedResponse = await fetch(`${baseUrl}/users/${created.id}`);
    expect(fetchedResponse.status).toBe(200);
    const fetched = (await fetchedResponse.json()) as UserResponse;
    expect(fetched).toEqual(created);

    child.kill("SIGTERM");
    const exitCode = await withTimeout(child.exited, shutdownTimeoutMs, "server shutdown");
    expect(exitCode).toBe(0);

    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    expect(stdout).toContain('"message":"server.stopping"');
    expect(stdout).toContain('"message":"server.stopped"');
    gracefulShutdownVerified = true;

    // Keep stderr captured for diagnostics, but do not require it to be empty:
    // package runners may legitimately write command metadata there.
    void stderr;
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    throw failureWithLogs(error, await stdoutPromise, await stderrPromise);
  } finally {
    if (!gracefulShutdownVerified && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});
```

- [ ] **Step 4: Run the E2E directly against a migrated local PostgreSQL instance**

Run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app bun run db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app bun test tests/e2e
```

Expected: PASS when PostgreSQL is available and migrated. Any failure must include child stdout/stderr. Do not replace `bun run start` with an in-process shortcut to make the test pass.

- [ ] **Step 5: Commit the E2E harness and scenario**

```bash
git add tests/e2e/helpers/free-port.ts tests/e2e/server.e2e.ts
git commit -m "test: add production-process E2E scenario"
```

---

### Task 3: Wire public commands and the required GitHub Actions E2E job

**Files:**
- Modify: `package.json`
- Modify: `justfile`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/unit/tooling/quality-commands.test.ts`
- Test: `tests/unit/tooling/e2e-gate.test.ts`

**Interfaces:**
- Consumes: `tests/e2e`, `db:migrate`, existing PostgreSQL Actions service pattern.
- Produces: `test:e2e`, `ci:e2e`, `just test-e2e`, independent `e2e` Actions job, four-component `required` gate, full local `ci` parity.

- [ ] **Step 1: Add package scripts with no duplicate migration in full CI**

Set these exact scripts in `package.json`:

```json
"test:e2e": "bun test tests/e2e",
"ci:e2e": "bun run db:migrate && bun run test:e2e",
"ci": "bun run check && bun run test:coverage && bun run ci:integration && bun run test:e2e"
```

Keep:

```json
"ci:integration": "bun run db:migrate && bun run test:integration"
```

Standalone `ci:e2e` owns migration. Full `ci` migrates once in `ci:integration` and runs `test:e2e` directly afterward.

- [ ] **Step 2: Add the Just wrapper**

Add near the existing test recipes:

```make
test-e2e:
  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run test:e2e
```

- [ ] **Step 3: Add the independent GitHub Actions job**

Add:

```yaml
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:18-alpine
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: app_e2e
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d app_e2e"
          --health-interval 2s
          --health-timeout 3s
          --health-retries 20
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/app_e2e
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version-file: ".bun-version"
      - name: Verify Bun toolchain version
        run: test "$(bun --version)" = "$(tr -d '\r\n' < .bun-version)"
      - run: test -f bun.lock
      - run: bun ci
      - run: bun run ci:e2e
```

- [ ] **Step 4: Make E2E mandatory in `required`**

Set:

```yaml
needs: [quality, integration, coverage, e2e]
```

Add:

```yaml
E2E_RESULT: ${{ needs.e2e.result }}
```

and:

```bash
test "$E2E_RESULT" = "success"
```

- [ ] **Step 5: Update the existing exact full-CI contract**

In `tests/unit/tooling/quality-commands.test.ts` change only the expected `scripts.ci` value to:

```ts
expect(packageJson.scripts?.ci).toBe(
  "bun run check && bun run test:coverage && bun run ci:integration && bun run test:e2e",
);
```

- [ ] **Step 6: Verify tooling GREEN and real E2E execution in CI**

Run locally where possible:

```bash
bun test tests/unit/tooling/e2e-gate.test.ts tests/unit/tooling/quality-commands.test.ts
```

Expected: PASS.

Push the branch and require:

```text
quality      success
coverage     success
integration  success
e2e          success
required     success
```

The `e2e` job must show successful `bun run ci:e2e`.

- [ ] **Step 7: Commit command and CI wiring**

```bash
git add package.json justfile .github/workflows/ci.yml tests/unit/tooling/e2e-gate.test.ts tests/unit/tooling/quality-commands.test.ts
git commit -m "ci: require black-box E2E verification"
```

---

### Task 4: Document the E2E layer and complete repository verification

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/repository-governance.md`
- Modify: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: final public commands and CI semantics from Task 3.
- Produces: contributor-facing documentation that consistently describes the E2E layer and the five CI jobs including the aggregate gate.

- [ ] **Step 1: Update README testing/command documentation**

Document these public commands:

```text
just test-e2e     # real production process + PostgreSQL over TCP
bun run ci:e2e    # migrate then run standalone E2E
just ci           # quality + coverage + integration + E2E
```

State that E2E launches `bun run start`, waits for `/health/ready`, exercises create/fetch user over real HTTP, and verifies SIGTERM shutdown. Keep negative HTTP cases in `tests/api` and persistence-detail tests in `tests/integration`.

- [ ] **Step 2: Update CONTRIBUTING**

Add `test-e2e` to the contributor verification ladder and recommend `just ci` before opening a PR when PostgreSQL is available. State that the independent `e2e` Actions job is required even when lower-level suites pass.

- [ ] **Step 3: Update governance and PR checklist**

In `docs/repository-governance.md`, define required CI components as `quality`, `coverage`, `integration`, and `e2e`, aggregated by `required`.

In `.github/pull_request_template.md`, add local E2E/full-CI verification and Actions `e2e` checks.

- [ ] **Step 4: Run the final branch verification**

On the exact final branch head require:

```text
quality      completed / success
coverage     completed / success
integration  completed / success
e2e          completed / success
required     completed / success
```

Compare `main...test/black-box-e2e` and verify there are no unrelated runtime dependency, database schema, or production behavior changes.

- [ ] **Step 5: Open PR #25 and perform review checks**

Use title:

```text
test: add black-box production E2E gate
```

The PR body must include initial RED CI evidence, first real E2E GREEN evidence, exact final head SHA, production path covered, and confirmation that no dependency/schema change was introduced.

Inspect the PR patch, review submissions, and review threads. Do not merge with unresolved review threads or a changed/unverified head SHA.

- [ ] **Step 6: Verify PR-triggered CI on the exact PR head**

Require `quality`, `coverage`, `integration`, `e2e`, and `required` to succeed on that exact SHA.

- [ ] **Step 7: Squash merge and verify `main`**

Squash merge only with the validated expected head SHA. Then verify the merge commit itself on `main` has all five jobs completed with conclusion `success`.

- [ ] **Step 8: Commit documentation**

```bash
git add README.md CONTRIBUTING.md docs/repository-governance.md .github/pull_request_template.md
git commit -m "docs: describe black-box E2E verification"
```
