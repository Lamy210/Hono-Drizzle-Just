# CI Governance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable aggregate CI merge gate, explicit time bounds, and stale-run cancellation, then align repository governance documentation with that gate.

**Architecture:** Keep `quality` and `integration` as independently diagnosable jobs. Add a tiny `required` job as the stable governance interface; it depends on both component jobs and succeeds only when both conclude successfully. Repository-admin settings remain separate from source-controlled policy.

**Tech Stack:** GitHub Actions, Bun 1.4.2, PostgreSQL 18 service container.

**Spec:** `docs/superpowers/specs/2026-09-16-ci-governance-hardening-design.md`

## Global Constraints

- Do not modify application runtime code or dependencies.
- Keep third-party Actions pinned to immutable full commit SHAs.
- Preserve existing `quality` and `integration` verification steps.
- `quality` timeout: 10 minutes.
- `integration` timeout: 15 minutes.
- `required` timeout: 2 minutes.
- `required` must use `if: ${{ always() }}` and fail unless both upstream job results equal `success`.
- Do not claim GitHub rulesets or merge settings were changed unless an administration write actually succeeds.

---

### Task 1: Harden workflow execution

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces check names: `quality`, `integration`, `required`.
- `required` consumes `needs.quality.result` and `needs.integration.result`.

- [ ] **Step 1: Add workflow-level concurrency**

Add:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

- [ ] **Step 2: Bound component jobs**

Add `timeout-minutes: 10` to `quality` and `timeout-minutes: 15` to `integration` without changing their existing commands.

- [ ] **Step 3: Add the stable aggregate gate**

Add:

```yaml
  required:
    name: required
    if: ${{ always() }}
    needs: [quality, integration]
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - name: Verify required jobs
        env:
          QUALITY_RESULT: ${{ needs.quality.result }}
          INTEGRATION_RESULT: ${{ needs.integration.result }}
        run: |
          test "$QUALITY_RESULT" = "success"
          test "$INTEGRATION_RESULT" = "success"
```

- [ ] **Step 4: Verify GitHub accepts the workflow**

Push the workflow change and inspect the branch workflow run. Expected: workflow parses and all three jobs are created; `required` starts only after component jobs finish.

---

### Task 2: Align governance documentation

**Files:**
- Modify: `docs/repository-governance.md`
- Modify: `.github/pull_request_template.md`

**Interfaces:**
- Governance requires exact check name `required`.
- PR checklist still exposes component jobs for diagnosis and adds the aggregate gate.

- [ ] **Step 1: Replace direct component checks in the recommended ruleset**

Document `required` as the only exact required status check. Explain that it fails unless `quality` and `integration` both succeed.

- [ ] **Step 2: Preserve strict/up-to-date policy**

Keep branch-up-to-date, pull-request, conversation-resolution, linear-history, force-push, deletion, review-count, and bypass guidance unchanged unless wording must be clarified for the aggregate gate.

- [ ] **Step 3: Update PR verification checklist**

Add `CI required passes` while retaining `quality` and `integration` items as diagnostic verification.

---

### Task 3: Verify repository-admin drift and finish PR

**Files:**
- No source file required unless documentation needs correction based on observed settings.

- [ ] **Step 1: Re-read repository rulesets and merge settings**

Expected current drift before admin configuration:

```text
rulesets: none
allow_squash_merge: true
allow_merge_commit: true
allow_rebase_merge: true
auto delete merged branches: not confirmed enabled
```

- [ ] **Step 2: Check available GitHub actions for administration writes**

If no write action exists for repository settings/rulesets, leave admin state unchanged and report the exact limitation. Do not simulate the change in docs as completed state.

- [ ] **Step 3: Open PR after branch CI succeeds**

PR title:

```text
ci: harden merge gate and workflow execution
```

- [ ] **Step 4: Require PR-event CI on the PR head SHA**

Expected: `quality=success`, `integration=success`, `required=success`.

- [ ] **Step 5: Squash merge with expected head SHA and verify main CI**

After merge, verify `main` push CI reports all three jobs successful.
