# Dependency automation

This repository uses Renovate configuration from `renovate.json5` to define dependency-update policy. The configuration is intentionally conservative: Renovate may open and maintain pull requests, but it does not auto-merge them.

## Scope

Only these Renovate managers are enabled:

- `bun` for `package.json` and `bun.lock` dependency updates.
- `bun-version` for the exact Bun toolchain declared in `.bun-version`.
- `github-actions` for workflow Action revisions.

Docker images and unrelated package-manager formats are deliberately outside this policy until they are reviewed as separate automation surfaces.

## Update policy

Routine Bun package patch updates are grouped to reduce PR noise. OpenTelemetry packages are grouped separately because their API/SDK/exporter versions need compatibility review, and `drizzle-orm` plus `drizzle-kit` are grouped so runtime ORM and migration tooling can be tested together.

Minor and major dependency updates otherwise remain separate Renovate PRs. `.bun-version` updates are also kept separate from package updates so a runtime/toolchain change is reviewed independently.

Renovate performs weekly Bun lockfile maintenance. `bun.lock` remains committed source-of-truth and every generated dependency PR must pass the repository's existing quality and PostgreSQL integration CI before merge.

## GitHub Actions

GitHub Actions remain pinned to full immutable commit SHAs. Renovate's GitHub Actions manager and `helpers:pinGitHubActionDigests` preset update those digests without reverting workflows to mutable tags. Human-readable major-version comments such as `# v7` remain documentation only.

## Merge policy

`automerge` is disabled. Patch updates are not exempt from review. After the repository has accumulated enough real Renovate PR history to evaluate update quality and CI reliability, narrowly scoped auto-merge rules can be proposed in a separate change.

## Dependency Dashboard

Renovate's Dependency Dashboard is enabled so pending, rate-limited, ignored, or otherwise deferred updates have one visible control surface instead of being inferred from individual PRs.

## Activation and configuration validation

`renovate.json5` defines repository policy but does not run Renovate by itself. The Renovate GitHub App (or an equivalent trusted Renovate runner) must have access to this repository before update PRs and the Dependency Dashboard can be created.

Configuration changes should be validated with Renovate's own validator before merge. For the hosted Renovate app, the special `renovate/reconfigure` branch can also request app-side validation. Do not add an unpinned, always-running Renovate download to the normal application CI merely to validate infrequent policy edits.
