# Migration Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CI schema push with committed Drizzle migration history and enforce that schema changes ship with migration artifacts.

**Architecture:** Keep TypeScript schema as the authoring model, commit generated SQL/snapshot history under `drizzle/`, and apply it to empty CI PostgreSQL databases with `drizzle-kit migrate`. Add a migration verification command that catches history conflicts and schema changes without a committed migration.

**Tech Stack:** Bun 1.4.2, Drizzle ORM 0.45.2, Drizzle Kit 0.31.10, PostgreSQL 18, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-13-migration-workflow-design.md`

## Global Constraints

- CI must not use `drizzle-kit push` or `push --force`.
- `db:push` remains available only as a documented local-development convenience.
- Integration tests must start from the empty PostgreSQL service database and apply committed migrations first.
- Migration SQL, journal, and snapshot metadata must be committed together.
- A TypeScript schema change without corresponding migration artifacts must fail the quality job.
- API startup must not automatically migrate the database.

---

### Task 1: Establish migration application contract

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Create: `drizzle/0000_initial.sql`
- Create: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0000_snapshot.json`

**Interfaces:**
- Consumes: `drizzle.config.ts` with `schema=./src/db/schema/index.ts` and `out=./drizzle`.
- Produces: `bun run db:migrate`, which applies the committed history to `DATABASE_URL`.

- [ ] **Step 1: Make CI require `bun run db:migrate` before integration tests.**

- [ ] **Step 2: Run PR CI and verify RED.**

Expected failure: package script `db:migrate` does not exist yet. This proves integration setup no longer depends on `push --force`.

- [ ] **Step 3: Add the `db:migrate` script and initial Drizzle migration artifacts.**

The SQL migration must create exactly the current `users` table:

```sql
CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(320) NOT NULL,
  "name" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE("email")
);
```

- [ ] **Step 4: Run PR CI and verify the integration job applies migrations and passes all integration tests.**

- [ ] **Step 5: Commit the GREEN state.**

### Task 2: Reject migration-history drift

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `justfile`

**Interfaces:**
- Produces: `db:check` and `db:migrations:verify` scripts plus `just db-check`, `just db-migrate`, and `just db-verify` shortcuts.

- [ ] **Step 1: Add a quality-job call to `bun run db:migrations:verify` before implementing that script.**

- [ ] **Step 2: Run PR CI and verify RED because the verification script is absent.**

- [ ] **Step 3: Implement scripts.**

```json
{
  "db:check": "drizzle-kit check",
  "db:migrate": "drizzle-kit migrate",
  "db:migrations:verify": "drizzle-kit check && drizzle-kit generate && git diff --exit-code -- drizzle"
}
```

Keep `db:push` unchanged for local development.

- [ ] **Step 4: Add matching `just` recipes and run CI to GREEN.**

### Task 3: Document migration policy and review

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Document authoring (`generate`), CI/deployment (`migrate`), history verification, and local-only `push`.**

- [ ] **Step 2: Explicitly document that API startup does not run migrations and that pre-existing pushed databases need an explicit baseline procedure.**

- [ ] **Step 3: Review the PR diff for accidental production startup migration, missing snapshot/journal files, or remaining CI `push --force`.**

- [ ] **Step 4: Verify final quality and PostgreSQL integration jobs from the final PR head before merge.**
