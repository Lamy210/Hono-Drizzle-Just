# Template Bootstrap / Doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic `init` and static `doctor` commands for repositories created from this template, without adding dependencies or performing repository-wide string replacement.

**Architecture:** A focused `scripts/template/` subsystem owns identity inference/validation, active-file transformation/state classification, process execution, initialization orchestration with rollback, and static doctor checks. Package scripts and `just` only delegate to the CLI entrypoints. Tests use temporary fixture directories and injected command runners so they never mutate the real checkout.

**Tech Stack:** Bun 1.4.2, TypeScript 7.0.2, Bun test, Node-compatible standard library (`node:fs`, `node:path`, `node:util` when needed).

**Spec:** `docs/superpowers/specs/2026-09-16-template-bootstrap-doctor-design.md`

## Global Constraints

- Add no runtime or development dependency.
- `template:init` supports `--name`, `--package-name`, `--service-name`, `--repository`, and `--dry-run`; all are optional when inference is safe.
- No interactive prompt in v1.
- Source identity is exactly `Hono-Drizzle-Just`, `hono-drizzle-just-template`, `hono-drizzle-just`, `Lamy210/Hono-Drizzle-Just`.
- Managed active identity is limited to `package.json`, root workspace name in `bun.lock`, the README opening identity block, `.env.example` `SERVICE_NAME`, and the runtime `SERVICE_NAME` default.
- `bun.lock` is never edited directly; real initialization runs `bun install --lockfile-only` and verifies the root workspace name afterward.
- `--dry-run` writes nothing and does not invoke lockfile regeneration.
- Initialization is allowed only for pristine source state or an exact already-initialized target state; mixed/unsupported state fails closed.
- Failures after writes begin restore captured managed files, including `bun.lock`.
- `template:doctor` is static/local: no network and no database connection.
- Database renaming remains out of scope.

---

### Task 1: Identity parsing and validation

**Files:**
- Create: `scripts/template/identity.ts`
- Create: `tests/unit/template/identity.test.ts`

**Interfaces:**
- Produces: `TemplateIdentity`
- Produces: `parseGitHubRepository(value: string): string | undefined`
- Produces: `resolveTemplateIdentity(input: IdentityInput): TemplateIdentity`
- Produces: `SOURCE_TEMPLATE_IDENTITY`

- [ ] **Step 1: Write failing identity tests**

Cover HTTPS, SCP-like SSH, and `ssh://` GitHub remotes; rejection of non-GitHub remotes; derivation from `ExampleAPI`; and explicit invalid display/package/service input.

- [ ] **Step 2: Run `bun test tests/unit/template/identity.test.ts` and verify RED**

Expected failure: module/functions do not exist.

- [ ] **Step 3: Implement the minimal identity module**

Use this public shape:

```ts
export interface TemplateIdentity {
  readonly displayName: string;
  readonly packageName: string;
  readonly serviceName: string;
  readonly repositorySlug: string;
}

export interface IdentityInput {
  readonly repository?: string;
  readonly displayName?: string;
  readonly packageName?: string;
  readonly serviceName?: string;
}
```

Validation rules:

```text
displayName: trimmed, non-empty, no CR/LF
packageName: lowercase unscoped npm-safe name using [a-z0-9._-], starts/ends with alphanumeric, <= 214 chars
serviceName: lowercase [a-z0-9-], starts/ends alphanumeric, <= 100 chars
repositorySlug: owner/repo, each component non-empty, GitHub-specific
```

Repository name derivation uses word boundaries/case transitions for service kebab-case and a lowercase compact npm name only where the repository name itself contains no separators; otherwise preserve safe `-` separators. Explicit invalid values are rejected rather than silently repaired.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

- [ ] **Step 5: Commit the identity cycle**

---

### Task 2: Managed repository file model and state classification

**Files:**
- Create: `scripts/template/repository-files.ts`
- Create: `tests/unit/template/repository-files.test.ts`

**Interfaces:**
- Consumes: `TemplateIdentity`, `SOURCE_TEMPLATE_IDENTITY`
- Produces: `readManagedRepository(root: string): Promise<ManagedRepositorySnapshot>`
- Produces: `classifyRepositoryState(snapshot, target): "pristine" | "target" | "mixed"`
- Produces: `planIdentityChanges(snapshot, target): PlannedFileChange[]`
- Produces: `readLockfileRootName(text: string): string | undefined`

- [ ] **Step 1: Write fixture-based failing tests**

Create temporary fixture repositories containing the managed source files. Assert pristine classification, exact target classification, mixed-state rejection, and narrow transformations that leave later README references untouched.

- [ ] **Step 2: Verify RED with `bun test tests/unit/template/repository-files.test.ts`**

- [ ] **Step 3: Implement snapshot readers and narrow transformers**

`package.json` is parsed and serialized with two spaces plus trailing newline. `.env.example` requires exactly one `SERVICE_NAME=` assignment. `config.schema.ts` requires exactly one anchored `SERVICE_NAME` default expression matching source or target. README only replaces the first H1 plus the immediate opening description block; later references remain byte-for-byte unchanged.

`bun.lock` is read-only in this module. `readLockfileRootName` parses the root workspace name conservatively from the textual lockfile and fails when it cannot identify exactly one root workspace name.

- [ ] **Step 4: Verify GREEN**

- [ ] **Step 5: Commit the repository-file cycle**

---

### Task 3: Process runner and target identity inference

**Files:**
- Create: `scripts/template/process-runner.ts`
- Create: `tests/unit/template/process-runner.test.ts`
- Modify: `scripts/template/identity.ts`
- Modify: `tests/unit/template/identity.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
}
```

- Produces: `createBunCommandRunner(): CommandRunner`
- Produces: `inferIdentityFromOrigin(runner, root, overrides): Promise<TemplateIdentity>`

- [ ] **Step 1: Write RED tests proving argv-array execution and origin inference**

Tests inject a fake runner for `git remote get-url origin`; non-zero/missing/unrecognized origins require explicit repository identity.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement runner using `Bun.spawn` with an explicit argv array and cwd**

Capture stdout/stderr text, return exit code, and never shell-concatenate user input.

- [ ] **Step 4: Implement identity inference using the runner**

Explicit `--repository` wins. Otherwise execute exactly `git remote get-url origin` and parse only recognized GitHub forms.

- [ ] **Step 5: Verify GREEN and commit**

---

### Task 4: Initialization orchestration with dry-run and rollback

**Files:**
- Create: `scripts/template/init-lib.ts`
- Create: `tests/unit/template/init.test.ts`

**Interfaces:**
- Consumes: identity resolution, repository snapshot/planner, `CommandRunner`
- Produces:

```ts
export interface InitOptions {
  readonly root: string;
  readonly target: TemplateIdentity;
  readonly dryRun: boolean;
  readonly runner: CommandRunner;
}

export interface InitResult {
  readonly status: "changed" | "unchanged" | "dry-run";
  readonly changedFiles: readonly string[];
}

export async function initializeTemplate(options: InitOptions): Promise<InitResult>;
```

- [ ] **Step 1: Write RED tests for pristine initialization and dry-run**

Dry-run must make zero writes and must not call `bun install --lockfile-only`.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement the minimal successful orchestration**

Read/capture all managed files, classify state, compute changes, write non-lockfile files via temp-file+rename, run exactly `bun install --lockfile-only`, then re-read `bun.lock` and verify target root workspace name.

- [ ] **Step 4: Add RED tests for idempotent rerun and different-target rejection**

Exact same target returns `unchanged`; a different requested target after initialization throws before any write/command.

- [ ] **Step 5: Implement and verify GREEN**

- [ ] **Step 6: Add RED rollback tests**

Prove a non-zero lockfile command result and a post-command lockfile mismatch both restore the original `package.json`, README, `.env.example`, config schema, and `bun.lock`.

- [ ] **Step 7: Implement rollback and verify GREEN**

Restore exact captured text using the same atomic writer. If rollback itself fails, throw an error that reports initialization failure and rollback failure together; never return `changed`.

- [ ] **Step 8: Commit the init orchestration cycle**

---

### Task 5: `template:init` CLI

**Files:**
- Create: `scripts/template/init.ts`
- Create: `tests/unit/template/init-cli.test.ts`

**Interfaces:**
- Consumes: `inferIdentityFromOrigin`, `initializeTemplate`, production command runner
- Produces: CLI with options `--name`, `--package-name`, `--service-name`, `--repository`, `--dry-run`

- [ ] **Step 1: Write RED parser/CLI tests**

Test explicit overrides, unknown option rejection, missing option value rejection, dry-run summary, changed summary, and error exit behavior without invoking the real checkout.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement CLI argument parsing and orchestration**

Use `node:util` `parseArgs` or a small deterministic parser. The CLI main accepts injected argv/root/runner/output callbacks for tests; the executable path only translates `Bun.argv` and `process.cwd()` into that main.

- [ ] **Step 4: Verify GREEN and commit**

---

### Task 6: Static doctor engine and CLI

**Files:**
- Create: `scripts/template/doctor-lib.ts`
- Create: `scripts/template/doctor.ts`
- Create: `tests/unit/template/doctor.test.ts`

**Interfaces:**
- Produces:

```ts
export type DoctorStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorResult {
  readonly status: DoctorStatus;
  readonly check: string;
  readonly message: string;
}

export async function runDoctor(options: {
  readonly root: string;
  readonly runner: CommandRunner;
}): Promise<{ readonly results: readonly DoctorResult[]; readonly exitCode: 0 | 1 | 2 }>;
```

- [ ] **Step 1: Write RED doctor tests**

Cover fully initialized PASS, package/lockfile mismatch FAIL, env/runtime service mismatch FAIL, inconsistent repository URLs FAIL, missing/unrecognized origin WARN, recognized origin mismatch WARN, pristine source template diagnostic state, and stable summary counts.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement checks**

Use `.bun-version` + `bun --version`, package/lockfile identity, GitHub metadata consistency, source-residue logic, service-name consistency, README first H1/opening block, and optional origin comparison. Do not access the network or database.

- [ ] **Step 4: Implement line-oriented CLI output and exit codes**

Format each result as `<STATUS> <check padded-or-separated> <message>`, then one summary line. ANSI color is optional but status words remain present as text.

- [ ] **Step 5: Verify GREEN and commit**

---

### Task 7: Expose commands through package scripts and just

**Files:**
- Modify: `package.json`
- Modify: `justfile`
- Test: existing typecheck/lint plus CLI tests

**Interfaces:**
- Produces package scripts:
  - `template:init`: `bun scripts/template/init.ts`
  - `template:doctor`: `bun scripts/template/doctor.ts`
- Produces `just init *args` delegating to `bun run template:init -- {{args}}`
- Produces `just doctor` delegating to `bun run template:doctor`

- [ ] **Step 1: Add command wiring**

Configuration-only step; no separate RED cycle is required by TDD policy.

- [ ] **Step 2: Run focused tests, lint, and typecheck through CI**

- [ ] **Step 3: Commit command wiring**

---

### Task 8: README first-use workflow and regression alignment

**Files:**
- Modify: `README.md`
- Modify if required: `tests/unit/config/load-config.test.ts`

- [ ] **Step 1: Replace manual-first bootstrap instructions**

Preferred flow:

```bash
bun install
just init
just doctor
just db-up
just db-migrate
just check
just test-all
```

Explain `just init -- --name ...`/flags if inference is not appropriate, document `--dry-run`, explain mixed-state fail-closed behavior, retain manual fallback, and keep DB rename as optional/manual.

- [ ] **Step 2: Ensure runtime SERVICE_NAME default test remains explicit**

The source template's test continues to expect `hono-drizzle-just`; generated repositories will have this managed assertion rewritten together with runtime default only if the implementation elects to manage that specific assertion. If test-source mutation is not needed, document that generated consumers should update the assertion through init planning and include it as a managed file before merge.

- [ ] **Step 3: Run full CI and commit docs/regression alignment**

---

### Task 9: Final verification, PR, and merge

**Files:** all changed files.

- [ ] **Step 1: Compare branch to `main` and review scope**

No database rename, no DB/network doctor, no new dependency, no arbitrary repository-wide replace, no GitHub API write, no `--force`.

- [ ] **Step 2: Require fresh branch/PR CI**

Current head must pass `quality`, `integration`, and aggregate `required`.

- [ ] **Step 3: Open PR #22-equivalent**

Title:

```text
feat: add template bootstrap and doctor commands
```

Include temp-fixture/TDD evidence, dry-run/rollback behavior, dependency review, and non-goals.

- [ ] **Step 4: Review unresolved threads and mergeability**

Require no unresolved review thread and a mergeable PR.

- [ ] **Step 5: Squash merge using expected head SHA**

- [ ] **Step 6: Verify merge commit CI on `main`**

Require all three jobs (`quality`, `integration`, `required`) and the workflow run itself to conclude `success`.