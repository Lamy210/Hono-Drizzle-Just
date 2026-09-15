# Template Bootstrap / Doctor Design

## Status

Approved in chat on 2026-09-16. This document turns that approved design into an implementation contract for PR #22.

## Problem

Creating a repository from this template currently requires a coordinated set of manual identity edits. The active project identity is spread across `package.json`, `bun.lock`, the README heading/intro, `.env.example`, and the runtime `SERVICE_NAME` default in `src/config/config.schema.ts`. The README intentionally warns against global search-and-replace because template identifiers also appear in documentation, historical design records, fixtures, and intentionally generic examples.

The template therefore needs two separate developer-experience capabilities:

1. `init`: perform the supported active-identity migration safely and atomically.
2. `doctor`: diagnose whether a generated repository is internally consistent without mutating it.

These commands are for template consumers. They are not deployment tooling and are not part of application runtime composition.

## Goals

- Reduce the manual steps required immediately after GitHub **Use this template**.
- Use Bun and Node-compatible standard-library capabilities already available in the repository; add no runtime or development dependency.
- Make every write target explicit instead of doing repository-wide text replacement.
- Make initialization deterministic, idempotent for the same identity, and fail-closed for mixed/partially customized states.
- Regenerate only the root workspace metadata in `bun.lock` through Bun's lockfile-only install path rather than editing lockfile text manually.
- Roll back identity file changes when lockfile regeneration fails.
- Provide a network- and database-independent `doctor` suitable for use immediately after cloning/generated-repository setup.
- Keep database renaming, database connectivity checks, rate limiting, deployment checks, and unrelated template customization out of this PR.

## Non-goals

- Renaming the default local PostgreSQL databases (`app`, `app_test`).
- Rewriting arbitrary references to `Hono-Drizzle-Just`, `hono-drizzle-just`, `app`, or `app_test` across the repository.
- Editing historical design documents under `docs/superpowers`.
- Creating or modifying GitHub repository settings, rulesets, topics, descriptions, or secrets.
- Calling the GitHub API.
- Detecting or changing deployment infrastructure.
- Validating a live PostgreSQL connection in the default doctor command.
- Adding a generic scaffolding/generator framework.
- Supporting an unrestricted `--force` mode in v1.

## Command surface

Expose the following commands:

```text
just init [args...]
just doctor

bun run template:init -- [args...]
bun run template:doctor
```

`just` delegates to package scripts. The package scripts invoke Bun entrypoints under `scripts/template/`.

### `template:init`

Supported CLI options:

```text
--name <display-name>
--package-name <npm-package-name>
--service-name <service-name>
--repository <owner/repo | GitHub URL>
--dry-run
```

All options are optional if their values can be inferred safely.

The command has no interactive prompt in v1. This keeps it deterministic in terminals, CI, agents, and future automation. If required identity cannot be inferred or validated, it exits non-zero and explains which flag is needed.

### `template:doctor`

No required options in v1. It reports checks as `PASS`, `WARN`, or `FAIL` and exits non-zero only when at least one `FAIL` is present.

## Identity model

Define one application-owned identity value object for the bootstrap subsystem:

```ts
interface TemplateIdentity {
  readonly displayName: string;
  readonly packageName: string;
  readonly serviceName: string;
  readonly repositorySlug: string; // owner/repo
}
```

Derived URLs are computed from `repositorySlug`:

```text
repository.url = git+https://github.com/<owner>/<repo>.git
bugs.url       = https://github.com/<owner>/<repo>/issues
homepage       = https://github.com/<owner>/<repo>#readme
```

### Default inference

Inference order:

1. Explicit CLI flag.
2. Git `origin` for repository identity when it is a recognized GitHub SSH or HTTPS URL.
3. Repository name component for display/package/service defaults.

Repository remote forms accepted for inference:

```text
https://github.com/owner/repo.git
https://github.com/owner/repo
git@github.com:owner/repo.git
ssh://git@github.com/owner/repo.git
```

Other Git hosts are not silently converted into GitHub metadata. Users can pass `--repository` explicitly only when it resolves to a GitHub `owner/repo` identity, because the template's package metadata fields in this design are GitHub-specific.

### Derived name defaults

Given repository name `ExampleAPI`:

- `displayName`: `ExampleAPI`
- `packageName`: normalized lowercase npm-safe form, e.g. `exampleapi`
- `serviceName`: normalized lowercase kebab-case form, e.g. `example-api`

Explicit `--package-name` and `--service-name` always win over derived defaults.

Package-name validation must reject invalid npm package names instead of trying to repair arbitrary explicit input. Service names must be non-empty, lowercase, ASCII alphanumeric plus `-`, start/end with alphanumeric, and fit the existing runtime maximum of 100 characters.

The display name must be non-empty after trimming and must not contain line breaks because it is written into the README heading and opening description.

## Source template identity

The source identity constants are:

```text
display name:    Hono-Drizzle-Just
package name:    hono-drizzle-just-template
service name:    hono-drizzle-just
repository slug: Lamy210/Hono-Drizzle-Just
```

These values are configuration of the template-bootstrap subsystem, not general repository-wide replacement tokens.

## Initialization state machine

`template:init` inspects every managed active-identity location before writing. It classifies the repository into one of three states.

### 1. Pristine template

Every managed location contains the expected source-template value. Initialization may proceed.

### 2. Already initialized to the requested identity

Every managed location contains the requested target value. The command is a successful no-op and reports that no changes are necessary.

### 3. Mixed / unsupported state

Managed locations do not consistently match either the source identity or requested target identity. Examples:

- `package.json#name` changed manually while `bun.lock` still has the template workspace name.
- `.env.example` changed while the runtime `SERVICE_NAME` default still uses `hono-drizzle-just`.
- package repository URL points somewhere else but README still has the source heading.
- a repository was initialized previously to identity A and is now being re-run requesting identity B.

The command must refuse to write in this state. It prints the mismatched fields and asks the user to reconcile them manually or restore the pristine template before retrying. v1 has no `--force` bypass.

## Managed files and exact responsibilities

### `package.json`

Update only:

- `name`
- `repository.url`
- `bugs.url`
- `homepage`

Do not change version, privacy, license, scripts, dependency versions, description, or engines.

### `bun.lock`

Never edit directly. After `package.json` changes, run:

```text
bun install --lockfile-only
```

The command must verify afterward that the root workspace `name` matches the target package name.

### `README.md`

Update only the active identity at the top of the file:

- first H1 heading
- opening template description line immediately following the heading block

Do not rewrite later documentation or historical references globally.

The target opening description remains structurally equivalent to the template copy but uses the target display name, for example:

```text
# Example API

Example API backend API template built around **Bun + Hono + Drizzle ORM + PostgreSQL + Zod + just**.
```

Wording may be slightly normalized during implementation, but the replacement boundary must stay limited to the opening identity block.

### `.env.example`

Update only the `SERVICE_NAME=` assignment.

### `src/config/config.schema.ts`

Update only the default string literal passed to the `SERVICE_NAME` schema. Do not alter validation or other configuration defaults.

### Configuration tests

Update or add tests so the runtime default remains synchronized with the generated `SERVICE_NAME` identity. Bootstrap implementation tests must not depend on mutating the actual repository checkout.

## File-update strategy

The bootstrap library reads managed files, parses structured files where practical, and uses anchored transformations for text files.

- Parse and serialize `package.json` as JSON, preserving the repository's normal two-space indentation and trailing newline.
- Parse `.env.example` line-by-line and require exactly one active `SERVICE_NAME=` assignment.
- Update `config.schema.ts` only through a narrowly anchored pattern that expects exactly one `SERVICE_NAME` default declaration matching either source or target state.
- Update the README opening identity block only when its expected source or target shape is recognized.
- Treat zero matches or multiple matches as an unsupported/mixed state, not as a reason to guess.

All planned edits are computed in memory before the first write.

## Atomicity and rollback

The init flow is transactional at the file-system level as far as practical:

1. Discover/validate target identity.
2. Read every managed file and capture exact original bytes/text.
3. Classify current state.
4. Compute every changed file in memory.
5. If `--dry-run`, print the plan and exit without writing or invoking Bun.
6. Write all non-lockfile managed files.
7. Run `bun install --lockfile-only` in the repository root.
8. Verify the new `bun.lock` root workspace name.
9. If any step after writes begin fails, restore every captured managed file, including the original `bun.lock` when Bun changed it.
10. Report success only after post-write validation passes.

Rollback failure is itself reported prominently and exits non-zero; the command must never claim a successful initialization after a partial rollback.

The implementation should use atomic per-file replacement where practical (`write temp -> rename`) so interruption does not leave a truncated JSON/text file.

## Dry-run behavior

`--dry-run` performs all discovery, validation, state classification, and transformation planning but:

- writes no file;
- does not run `bun install --lockfile-only`;
- prints each file that would change and the identity fields that would be applied;
- exits zero only when a real run would be permitted.

It must not print file contents that could contain unrelated user data.

## Doctor contract

`template:doctor` performs only static/local checks that do not require network or a running database.

### Checks

1. **Bun toolchain**
   - `.bun-version` exists and contains an exact version.
   - `bun --version` matches it.

2. **Lockfile presence and identity**
   - `bun.lock` exists.
   - root workspace name matches `package.json#name`.

3. **Package metadata identity**
   - `package.json#name` is valid.
   - repository/bugs/homepage URLs are mutually consistent and point to the same GitHub slug.

4. **Template-source residue in active metadata**
   - source template repository URL does not remain in active package metadata after customization.
   - source package name does not remain when other active identity fields indicate customization.

5. **Service-name consistency**
   - `.env.example` contains exactly one `SERVICE_NAME`.
   - runtime default in `config.schema.ts` is discoverable exactly once.
   - both values match.

6. **README active identity**
   - first H1 is present.
   - when package/repository identity indicates customization, the first H1/opening block must not remain the source template identity.

7. **Git origin consistency**
   - if `origin` is a recognizable GitHub remote, compare its slug to package metadata.
   - mismatch is `WARN`, not `FAIL`, because forks, mirrors, and intentionally different remotes are valid workflows.
   - missing/unrecognized origin is also `WARN`, not `FAIL`.

### Severity rules

`FAIL` means the generated repository has an internal contradiction that can break tooling or make published metadata misleading. Examples: package name vs lockfile mismatch, invalid package metadata URL set, env/runtime service-name disagreement.

`WARN` means the repository may be intentionally configured that way and requires human review. Examples: git-origin mismatch or missing origin.

`PASS` means a check was conclusively satisfied.

Exit code:

```text
0  no FAIL results (PASS and WARN are allowed)
1  one or more FAIL results
2  command/configuration/runtime usage failure that prevented doctor from completing
```

## Output design

Prefer stable, concise, line-oriented output that is readable by humans and future automation:

```text
PASS bun-version        Bun 1.4.2 matches .bun-version
PASS lockfile-name      example-api
PASS service-name       example-api
WARN git-origin         origin points to owner/fork while package metadata points to owner/example-api
FAIL package-metadata   repository/bugs/homepage do not resolve to one GitHub repository

Doctor: 3 passed, 1 warning, 1 failed
```

Do not use ANSI color as the only carrier of status meaning.

## Module boundaries

Create a focused `scripts/template/` subsystem. Exact filenames may be adjusted during the implementation plan if repository conventions require it, but responsibilities remain separated.

Recommended structure:

```text
scripts/template/
  identity.ts          # value object, validation, normalization, GitHub remote parsing
  repository-files.ts  # managed-file readers/transforms/state classification
  init.ts              # CLI orchestration, dry-run, writes, lockfile command, rollback
  doctor.ts            # static checks + result aggregation + CLI exit code
```

Tests:

```text
tests/unit/template/
  identity.test.ts
  repository-files.test.ts
  init.test.ts
  doctor.test.ts
```

The transformation/state logic must be testable against temporary directories and injected command execution. Unit tests must never rewrite the real checkout or invoke a real network operation.

## Process execution boundary

Do not shell-concatenate user input. Git and Bun subprocesses use argument arrays.

The subsystem needs a narrow command-runner abstraction so tests can inject deterministic outcomes for:

- `git remote get-url origin`
- `bun --version`
- `bun install --lockfile-only`

The production runner uses `Bun.spawn`/`Bun.spawnSync` or an equivalent Bun standard API with explicit argv arrays and a controlled working directory.

Stdout/stderr from failed commands may be summarized for diagnostics but must not be treated as trusted structured data beyond the specific command contract.

## Test strategy

### Identity unit tests

Cover:

- GitHub HTTPS remote parsing with/without `.git`.
- GitHub SCP-like SSH parsing (`git@github.com:owner/repo.git`).
- `ssh://git@github.com/...` parsing.
- rejection of non-GitHub remotes for automatic inference.
- display/package/service default derivation.
- explicit valid overrides.
- invalid package/service/display names.

### Repository transformation tests

Use fixture repositories in temporary directories and prove:

- pristine source state is recognized.
- exact requested target state is recognized as already initialized.
- every defined mixed-state example is rejected.
- only managed fields change.
- README later references remain untouched.
- zero/multiple anchored matches fail closed.

### Init orchestration tests

Prove:

- pristine template initializes all managed active identity fields.
- `--dry-run` makes zero writes and does not invoke lockfile regeneration.
- same identity rerun is successful and makes zero writes.
- requesting a different identity after initialization is rejected.
- lockfile command is invoked exactly as an argument array equivalent to `bun install --lockfile-only`.
- lockfile root-name verification is mandatory.
- lockfile command failure restores all original files.
- post-lockfile verification failure restores all original files.
- rollback failure produces non-zero status and does not emit a success message.

### Doctor tests

Prove:

- pristine template is diagnostically valid as a template but reports source identity clearly rather than pretending it is customized.
- fully initialized fixture returns exit code 0 with PASS results.
- package/lockfile mismatch is FAIL.
- env/runtime service mismatch is FAIL.
- malformed or inconsistent package repository URLs are FAIL.
- missing/unrecognized git origin is WARN only.
- recognized git origin mismatch is WARN only.
- summary counts and exit codes are stable.

### Existing configuration regression tests

Keep existing runtime config tests green and add coverage if needed for the `SERVICE_NAME` default that bootstrap mutates in generated repositories.

## CI / verification

No new dependency is introduced. Existing `quality`, `integration`, and aggregate `required` jobs remain the merge gate.

Implementation completion requires:

```text
bun run lint
bun run typecheck
bun run test
bun run test:integration
```

The PR must also show GitHub Actions `quality`, `integration`, and `required` as successful on the current head SHA.

A real destructive run of `template:init` against this source repository is not a verification step. Initialization behavior is proven using temporary-directory fixtures.

## README changes

Replace the current long manual "Required project identity changes" section with the preferred bootstrap flow while retaining a manual fallback explanation.

Target first-use flow:

```bash
bun install
just init
just doctor
just db-up
just db-migrate
just check
just test-all
just dev
```

Document `just init -- --dry-run` (or the exact just argument syntax validated during implementation) and the supported override flags.

Keep the optional database-renaming section, explicitly stating that `init` does not rename `app` / `app_test` in v1.

## Security and safety properties

- No secrets are read or printed beyond normal local command diagnostics.
- No `.env` file is modified; only `.env.example` is a managed identity target.
- No repository-wide replacement is performed.
- No remote network request is required by `doctor`.
- Init does not call GitHub APIs or mutate repository settings.
- User-controlled CLI values are never interpolated into a shell command.
- Existing customized/mixed states fail closed instead of being overwritten.
- File originals are captured before writes and restored on post-write failure.

## Future extensions

These are deliberately deferred:

- `template:doctor --database` for PostgreSQL reachability/migration checks.
- optional database rename support as a separately designed transaction.
- GitHub repository metadata/ruleset bootstrap.
- feature/module generators.
- interactive prompts.
- JSON output for doctor (`--format json`) if automation consumers emerge.

## Acceptance criteria

The design is complete when the implementation can demonstrate all of the following:

1. A pristine generated-template fixture can be initialized from GitHub `origin` plus optional overrides without global replacement.
2. The managed package, lockfile, README, env example, and runtime service identity are mutually consistent afterward.
3. `bun.lock` is regenerated through Bun, not hand-edited.
4. Dry-run writes nothing.
5. Same-identity rerun is a no-op.
6. Mixed/previously-different identity states are rejected without writes.
7. Lockfile failures restore the pre-run state.
8. Doctor detects package/lockfile and service-name contradictions with non-zero exit status.
9. Doctor tolerates missing/different Git origin as a warning.
10. No new dependency is added.
11. Existing application tests remain green.
12. GitHub Actions `quality`, `integration`, and aggregate `required` pass before merge.
