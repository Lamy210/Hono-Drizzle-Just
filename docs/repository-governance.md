# Repository governance

This document defines the repository-side governance policy and the GitHub settings that should enforce it. Files in the repository are versioned and reviewable; GitHub repository settings must be configured separately by an administrator.

## Ownership

`.github/CODEOWNERS` assigns default ownership to `@Lamy210` and explicitly covers governance, automation, security, and architecture files. CODEOWNERS provides review routing; it does not by itself require approval.

The repository is currently maintained by one owner, so the recommended ruleset does not require an approving review from a second person. Requiring one approval while only one maintainer can approve would make routine maintenance impossible without bypassing the policy. When a second trusted maintainer is added, change the ruleset to require at least one approval and enable required Code Owner review.

## Pull request policy

Changes to `main` should normally arrive through pull requests and use the repository pull request template.

Before merge:

- `quality` CI must succeed;
- `integration` CI must succeed;
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

Require these exact job names from `.github/workflows/ci.yml`:

- `quality`
- `integration`

Do not treat a skipped or cancelled job as successful. If these job names change, update the ruleset in the same operational change.

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

Prefer enabling squash merge and disabling merge commits for routine changes. Rebase merge may remain disabled unless the project deliberately adopts a different history policy.

Automatically deleting merged feature branches is safe for the repository's short-lived branch model and reduces stale branch accumulation.

## Security reporting

`SECURITY.md` is the public security policy. Vulnerability details must not be placed in public issues or pull requests. GitHub private vulnerability reporting / security advisories are the preferred reporting channel when enabled.

## Dependency automation

`renovate.json5` defines dependency update policy, but Renovate does not bypass normal review or required CI. Auto-merge remains disabled. See `docs/dependency-automation.md` for manager scope and grouping rules.

## Applying GitHub settings

Repository policy files can be changed through normal pull requests, but branch rulesets and repository merge settings require repository administration permission. After this governance change is merged, configure the GitHub settings to match this document and verify the required check names against an actual pull request run.

The connected automation used to maintain this repository does not have repository administration access, so it must not claim that branch protection or ruleset settings were changed when only the versioned policy files were updated.
