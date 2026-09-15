# CI Governance Hardening Design

## Goal

Make the repository's CI merge gate stable, bounded, and easier to map to GitHub branch governance without coupling rulesets to every internal CI job name.

## Current state

- CI runs `quality` and `integration` independently on `push` and `pull_request`.
- Neither job has an explicit timeout.
- There is no workflow concurrency policy, so obsolete runs can continue consuming runner time.
- Repository governance currently recommends requiring `quality` and `integration` directly.
- The repository currently has no repository ruleset returned by the GitHub Rulesets API.
- Repository merge settings still allow merge commits and rebase merges in addition to squash merges; automatic branch deletion is not enabled.

## Decisions

### Stable aggregate merge gate

Add a third job with job id and display name `required`.

`required` depends on `quality` and `integration`, uses `if: ${{ always() }}`, and fails unless both upstream jobs concluded with `success`.

GitHub governance should require only `required`. The component jobs remain visible for diagnosis but can be renamed or decomposed later without changing branch governance as long as the aggregate gate contract is preserved.

### Time bounds

Set explicit job limits:

- `quality`: 10 minutes
- `integration`: 15 minutes
- `required`: 2 minutes

These are intentionally much higher than current observed runtimes while preventing a hung command or service from consuming the platform default job timeout.

### Concurrency

Use workflow-level concurrency keyed by workflow plus PR number (for pull requests) or git ref (for push events):

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

This cancels stale runs for repeated updates to the same PR or branch while keeping push and pull-request event streams distinct. It deliberately does not try to deduplicate the two different event types for the same commit because duplicate check names with mixed cancelled/successful conclusions can make required-check diagnosis less predictable.

### Governance policy

Update `docs/repository-governance.md` so the recommended `main` ruleset requires exact status check `required`, not `quality` and `integration` directly.

The ruleset should otherwise continue to require:

- pull requests before merge;
- conversation resolution;
- linear history;
- strict required checks / branch up to date before merge;
- blocked force pushes;
- blocked deletion;
- zero approving reviews while there is only one trusted maintainer.

### Repository merge settings

Desired repository settings remain:

- squash merge enabled;
- merge commits disabled;
- rebase merge disabled unless deliberately adopted later;
- automatically delete head branches after merge enabled.

These settings and rulesets are repository-administration state, not source-controlled behavior. The connected GitHub capability may read but not expose write operations for them; documentation must not claim they were applied unless an actual administrative write succeeds.

## Verification

1. Workflow syntax is accepted by GitHub Actions.
2. `quality` succeeds.
3. `integration` succeeds.
4. `required` runs after both and succeeds only when both are `success`.
5. PR-event CI reports a successful `required` check on the current PR head SHA.
6. Governance docs name `required` as the only required status check.
7. No runtime dependency, application code, database schema, or migration changes are introduced.
