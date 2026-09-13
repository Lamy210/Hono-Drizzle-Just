# Migration Workflow Design

## Goal

Make committed SQL migrations the deployable database history while retaining `drizzle-kit push` only as an explicit local-development convenience.

## Source of truth

The TypeScript schema remains the authoring model. Schema changes intended for integration, staging, or production must be materialized with `drizzle-kit generate` and committed under `drizzle/` before merge.

`drizzle-kit migrate` is the only schema-application command used by CI. It applies committed migrations in order and records them in Drizzle's migration log. CI must never use `push --force`, because that bypasses migration-history validation and can hide missing migration artifacts.

## Commands

- `db:generate`: generate migration artifacts from the TypeScript schema.
- `db:migrate`: apply committed migrations to the configured database.
- `db:check`: check migration-history consistency.
- `db:migrations:verify`: check migration history, generate any missing schema diff, then fail if `drizzle/` changes.
- `db:push`: optional local-only schema synchronization; not a CI/deployment command.

## CI contract

The quality job verifies migration history and confirms the committed migration artifacts already represent the current TypeScript schema. The integration job starts with an empty PostgreSQL database, applies committed migrations, then executes integration tests.

A schema-only pull request without a generated migration must therefore fail CI before merge.

## Initial baseline

The repository currently has a `users` schema but no committed migration history. The first committed migration is a baseline that creates the existing `users` table from an empty PostgreSQL database, including its UUID primary key, unique email constraint, varchar limits, and timestamp default.

## Rollout boundary

This repository is still a template and CI databases are ephemeral, so the baseline can start from the current schema. Existing external databases previously managed with `push` are not automatically marked as migrated by this PR; adopting the history on a pre-existing database requires an explicit baseline/repair procedure instead of blindly executing the initial migration.

## Non-goals

- Automatically running migrations during API process startup.
- Destructive production reset/rollback automation.
- Automatically baselining an existing production database.
- Replacing Drizzle Kit with a custom migration engine.
- Removing `db:push` from local development.
