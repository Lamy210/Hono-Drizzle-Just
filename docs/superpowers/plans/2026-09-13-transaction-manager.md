# Transaction Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit Drizzle transaction boundaries without leaking infrastructure types into application services.

**Architecture:** A generic core `TransactionManager<TUnitOfWork>` is implemented by a generic Drizzle adapter. Composition supplies a transaction-session-to-unit-of-work factory, while feature services only depend on their repository ports.

**Tech Stack:** Bun 1.4.2, Drizzle ORM 0.45.2, node-postgres 8.23.x, PostgreSQL 18, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-13-transaction-manager-design.md`

## Global Constraints

- Application/domain code must not import Drizzle or `pg`.
- Transactions must use the same Drizzle transaction session for all repositories in the unit of work.
- Service unit tests must remain database-free and mock repository behavior.
- Integration tests must prove real commit and rollback behavior.
- No implicit AsyncLocalStorage transaction context.

---

### Task 1: Transaction port and unit-of-work contract

**Files:**
- Create: `src/core/transaction/transaction-manager.ts`
- Create: `src/modules/users/application/user-unit-of-work.ts`
- Modify test: `tests/unit/modules/users/create-user.service.test.ts`

- [ ] Change service tests to provide a mocked transaction manager whose unit of work contains a mocked `UserRepository`.
- [ ] Run CI and verify the tests/typecheck fail because transaction contracts do not exist yet.
- [ ] Add the minimal generic transaction port and users unit-of-work contract.

### Task 2: Drizzle transaction adapter

**Files:**
- Modify: `src/infrastructure/database/database.ts`
- Create: `src/infrastructure/database/drizzle-transaction-manager.ts`
- Modify: `src/modules/users/infrastructure/drizzle-user.repository.ts`
- Test: `tests/integration/transactions/drizzle-transaction-manager.test.ts`

- [ ] Add integration tests proving commit and rollback on a real PostgreSQL database.
- [ ] Verify red failure before implementation.
- [ ] Add `DatabaseSession` and generic Drizzle transaction adapter.
- [ ] Make `DrizzleUserRepository` accept a root or transactional session.
- [ ] Run integration tests and confirm both commit and rollback cases pass.

### Task 3: Use transaction in CreateUserService

**Files:**
- Modify: `src/modules/users/application/create-user.service.ts`
- Modify: `src/app/composition/container.ts`
- Modify: API test builders that construct `CreateUserService`.

- [ ] Run the duplicate and creation behavior through the transaction manager.
- [ ] Keep repository mocks inside the service unit test unit of work.
- [ ] Wire the production transaction manager in composition.
- [ ] Run lint, typecheck, unit/API, and PostgreSQL integration tests.

### Task 4: Documentation and merge

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] Document explicit transaction boundaries and rollback semantics.
- [ ] Review the diff for dependency-direction violations.
- [ ] Merge only after PR CI passes.
