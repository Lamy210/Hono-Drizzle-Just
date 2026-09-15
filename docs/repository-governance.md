# Repository governance

This document defines the repository-side governance policy and the GitHub settings that should enforce it. Files in the repository are versioned and reviewable; GitHub repository settings must be configured separately through repository administration controls.

## Ownership

`.github/CODEOWNERS` assigns default ownership to `@Lamy210` and explicitly covers governance, automation, security, and architecture files. CODEOWNERS provides review routing; it does not by itself require approval.

The repository is currently maintained by one owner, so the recommended ruleset does not require an approving review from a second person. Requiring one approval while only one maintainer can approve would make routine maintenance impossible without bypassing the policy. When a second trusted maintainer is added, change the ruleset to require at least one approval and enable required Code Owner review.

## Pull request policy

Changes to `main` should normally arrive through pull requests and use the repository pull request template.

Before merge:

- `quality` CI must succeed;
- `coverage` CI must succeed;
- `integration` CI must succeed;
- `e2e` CI must succeed;
- the aggregate `required` CI gate must succeed;
- review conversations must be resolved;
- database schema changes must include reviewed Drizzle migration history;
- dependency changes must preserve `bun.lock` reproducibility;
- GitHub Actions must remain pinned to immutable commit SHAs;
- security-sensitive changes must be reviewed for credential, PII, authorization, tenant-isolation, and telemetry leakage risks.

Squash merge is the preferred merge method so one pull request becomes one coherent commit on `main`.

## Recommended `main` ruleset

Create a repository ruleset targeting the default branch (`main`) with the following policy.

### Branch protections

- Restrict branch deletions.
- Block force pushes.
- Require a pull request before merging.
- Require all review conversations to be resolved before merging.
- Require linear history.
- Require branches to be up to date before merging so successful checks apply to the current `main` base.

### Required status checks

Require this exact job name from `.github/workflows/ci.yml`:

- `required`

`required` is the stable governance interface for CI. It uses `needs: [quality, integration, coverage, e2e]` plus `if: always()` and fails unless all four component jobs conclude with `success`. Keep `quality`, `coverage`, `integration`, and `e2e` as independently visible diagnostic jobs, but do not couple the GitHub ruleset directly to their names.

Do not treat a cancelled component job as success. If the aggregate gate name changes, update the ruleset in the same operational change. Internal decomposition or renaming of component jobs is allowed only when the `required` gate is updated to preserve equivalent coverage.

GitHub's strict required-check mode should remain enabled so a pull request must be up to date with `main` before its `required` result is accepted for merge.

### Review count

For the current single-maintainer repository:

- required approving reviews: `0`;
- required Code Owner approval: disabled.

After adding another trusted maintainer:

- required approving reviews: at least `1`;
- require Code Owner approval for owned paths;
- dismiss stale approvals when new commits materially change the reviewed diff.

### Bypass

Keep bypass scope minimal. Administrator bypass should be reserved for recovery from a broken ruleset or CI outage, not routine development. Any emergency direct change should be followed by a normal pull request or documented corrective change so `main` and repository policy converge again.

## Repository merge settings

Prefer enabling squash merge and disabling merge commits for routine changes. Rebase merge should remain disabled unless the project deliberately adopts a different history policy.

Automatically deleting merged feature branches is safe for the repository's short-lived branch model and reduces stale branch accumulation.

## CI execution policy

Verification has repository-level command layers:

- `just check-fast` / `bun run check:fast`: lint, typecheck, and unit/API tests with no PostgreSQL requirement;
- `just check` / `bun run check`: committed migration-history verification plus `check-fast`; this is the command executed by the CI `quality` job;
- `just coverage` / `bun run test:coverage`: unit/API coverage using Bun's native runner, with repository-owned minimums of 80% line coverage and 75% function coverage plus LCOV output;
- `just test-e2e` / `bun run test:e2e`: launch the real production entrypoint against an already-migrated `DATABASE_URL`, verify readiness and the critical user flow over loopback TCP, then verify SIGTERM shutdown;
- `bun run ci:e2e`: apply committed migrations and then run the standalone production-process E2E gate;
- `just ci` / `bun run ci`: `check`, coverage, one committed-migration application through `ci:integration`, PostgreSQL integration tests, and the E2E suite against that already-migrated database; with the same database environment, this is the local full-CI equivalent.

The E2E layer is intentionally broad and shallow. Detailed HTTP validation/error behavior remains in `tests/api`, while Drizzle, transaction, and persistence-adapter detail remains in `tests/integration`. `tests/e2e` proves that the production entrypoint, dependency composition, TCP server, PostgreSQL path, and shutdown lifecycle are connected correctly.

GitHub Actions keeps `quality`, `coverage`, `integration`, and `e2e` as separate jobs so the quality path, coverage gate, persistence path, and production-process path can run in parallel. The workflow should call the same package commands rather than duplicating their internal lint/typecheck/test sequence.

Coverage configuration lives in `bunfig.toml`; generated output lives under the ignored `coverage/` directory and CI verifies that `coverage/lcov.info` is non-empty. No external coverage SaaS is required by the default template. Bun coverage reflects files loaded by the selected test run, so the aggregate percentage is a regression gate and must not be interpreted as proof that every source file was included in measurement.

The CI workflow uses explicit time bounds rather than the platform's long default timeout:

- `quality`: 10 minutes;
- `coverage`: 10 minutes;
- `integration`: 15 minutes;
- `e2e`: 15 minutes;
- `required`: 2 minutes.

Workflow-level concurrency cancels an obsolete run when a newer run starts for the same pull request or the same push ref. Push and pull-request event streams remain separate so a cancelled run from one event type cannot obscure the required-check result produced by the other event type.

## Security reporting

`SECURITY.md` is the public security policy. Vulnerability details must not be placed in public issues or pull requests. GitHub private vulnerability reporting / security advisories are the preferred reporting channel when enabled.

## Dependency automation

`renovate.json5` defines dependency update policy, but Renovate does not bypass normal review or required CI. Auto-merge remains disabled. See `docs/dependency-automation.md` for manager scope and grouping rules.

## Applying GitHub settings

Repository policy files can be changed through normal pull requests, but branch rulesets and repository merge settings are administration state and must be configured through an administration-capable GitHub surface.

The connected GitHub integration used in this workflow can read repository/ruleset state and modify repository contents, but it does not currently expose write operations for repository rulesets or merge settings. It therefore must not claim that those settings were changed when only the versioned policy files were updated.

After this governance change is merged, configure the GitHub settings to match this document and verify the `required` check name against an actual pull-request run before making it mandatory.
