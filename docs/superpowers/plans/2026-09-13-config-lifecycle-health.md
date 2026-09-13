# Config, Lifecycle, and Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed startup configuration, deployment-safe health probes, and deterministic graceful shutdown to the Bun/Hono API template.

**Architecture:** Configuration is parsed once at the composition boundary. Health and lifecycle use core ports with PostgreSQL/Bun-specific adapters outside core. Hono exposes runtime-validated health contracts, and `server.ts` only wires signals and exit codes.

**Tech Stack:** Bun 1.4.2, Hono 4.13.x, Zod 4.6.x, Drizzle ORM 0.45.x, PostgreSQL 18, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-13-config-lifecycle-health-design.md`

## Global Constraints

- `core` must not import Hono, Drizzle, Zod, or PostgreSQL.
- No module except config loading may read environment variables directly.
- Liveness must never depend on PostgreSQL.
- Readiness dependency exceptions must produce a controlled 503, not an unhandled 500.
- Graceful shutdown must wait for in-flight requests before resource closure and must have a force-stop deadline.

---

### Task 1: Typed configuration

**Files:**
- Create: `src/config/config.schema.ts`
- Create: `src/config/load-config.ts`
- Test: `tests/unit/config/load-config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AppConfig`, `loadConfig(env): AppConfig`, `ConfigurationError`.

- [ ] Write config tests for defaults, coercion, URL scheme, numeric bounds, and redacted failures.
- [ ] Run CI and confirm tests/typecheck fail because config modules do not exist.
- [ ] Implement minimal config parser and error type.
- [ ] Run quality CI until lint, typecheck, and tests pass.

### Task 2: Health ports and routes

**Files:**
- Create: `src/core/health/health-check.ts`
- Create: `src/core/health/readiness-checker.ts`
- Create: `src/infrastructure/health/database-health-check.ts`
- Create: `src/contracts/common/health.ts`
- Create: `src/http/health/health.routes.ts`
- Test: `tests/unit/core/health/readiness-checker.test.ts`
- Test: `tests/api/health.test.ts`
- Modify: `src/app/app.ts`
- Modify: `src/app/composition/container.ts`

**Interfaces:**
- Produces: `HealthCheck`, `ReadinessChecker`, `DatabaseHealthCheck`, health response schemas.

- [ ] Write readiness and health API tests.
- [ ] Verify red failure.
- [ ] Implement health ports/adapters/contracts/routes.
- [ ] Verify quality and PostgreSQL integration CI.

### Task 3: Lifecycle and graceful shutdown

**Files:**
- Create: `src/core/lifecycle/application-lifecycle.ts`
- Create: `src/app/lifecycle/graceful-shutdown.ts`
- Test: `tests/unit/core/lifecycle/application-lifecycle.test.ts`
- Test: `tests/unit/app/lifecycle/graceful-shutdown.test.ts`
- Modify: `src/app/server.ts`
- Modify: `src/app/composition/container.ts`

**Interfaces:**
- Produces: `ApplicationLifecycle`, `GracefulShutdownCoordinator`.

- [ ] Write lifecycle and shutdown tests.
- [ ] Verify red failure.
- [ ] Implement reverse-order idempotent close and Bun server shutdown coordination.
- [ ] Verify all CI jobs.

### Task 4: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/architecture.md`

- [ ] Document health endpoints, configuration, and shutdown semantics.
- [ ] Run PR CI: lint, typecheck, unit/API tests, and PostgreSQL integration tests.
- [ ] Review PR diff for dependency-boundary violations and secret leakage.
- [ ] Merge only after all checks pass.
