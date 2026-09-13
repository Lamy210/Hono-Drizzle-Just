# Test Factory Framework Design

## Goal

Provide a small, strongly typed test-only factory foundation that can build domain-shaped data without a database and persist the same data through a real Drizzle/PostgreSQL session for repository/integration tests.

## API

`TestFactory<T>` exposes:
- `build(overrides?)`
- `buildMany(count, overrides?)`

`PersistentTestFactory<T, TCreated>` extends that behavior with:
- `create(overrides?)`
- `createMany(count, overrides?)`

A non-persistent factory does not expose `create` at the type level. Persistence is explicit when constructing a `PersistentTestFactory`.

Overrides may be either a partial object or a callback receiving `{ sequence }`. Sequence numbers are scoped to each factory instance; no module-global mutable sequence is used.

## User factory

`makeUserFactory()` returns a build-only factory. `makeUserFactory(databaseSession)` returns a persistent factory that inserts through the supplied root or transactional Drizzle session.

Default IDs are generated with `crypto.randomUUID()`. Default emails include a UUID suffix so separate factory instances do not collide in a shared test database. Tests that care about exact values override them explicitly.

## Relations

The base framework does not auto-create relations. Relation setup stays explicit:

```text
organization = await organizationFactory.create()
user = await userFactory.create({ organizationId: organization.id })
```

This avoids hidden database writes and allows the same composition to run inside a caller-owned transaction. Future feature factories can compose one another without changing the generic factory core.

## Persistence semantics

`createMany` persists sequentially in factory order. It is not implicitly atomic. Tests that require atomic multi-row setup must pass a transaction session to the persistent factory or wrap setup in the existing TransactionManager/Drizzle transaction.

## Testing

- Unit tests verify overrides, per-instance sequencing, bulk builds, invalid counts, and persistence ordering.
- Integration tests verify `makeUserFactory(databaseSession).create/createMany` creates rows readable by the real repository.
- Existing repository tests migrate from the one-off `createUserFactory()` function to the reusable factory object.

## Non-goals

- Faker dependency.
- Global factory registry.
- Automatic relation persistence.
- Traits/states DSL.
- Production runtime factory code.
