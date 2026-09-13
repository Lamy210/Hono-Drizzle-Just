# Transaction Manager Design

## Goal

Provide explicit transaction boundaries to application services without exposing Drizzle transaction types outside infrastructure, while preserving repository mocking in service unit tests and real-PostgreSQL repository/integration tests.

## Architecture

`core/transaction` owns a generic `TransactionManager<TUnitOfWork>` port. A feature application contract defines the repositories available inside its unit of work. `DrizzleTransactionManager<TUnitOfWork>` receives a factory that converts the active Drizzle transaction session into that unit of work.

```text
CreateUserService
      |
      v
TransactionManager<UserUnitOfWork>
      |
      v
DrizzleTransactionManager
      |
      +-- db.transaction(tx => ...)
      |
      v
{ users: DrizzleUserRepository(tx) }
```

Application services never import Drizzle or PostgreSQL types. The generic transaction adapter never imports feature repositories.

## Repository session

The database adapter exports a structural `DatabaseSession` containing only query-builder operations required by repositories. Both the root Drizzle database and a Drizzle transaction implement this shape. Repositories therefore work unchanged both inside and outside transactions.

## Create user use case

The sample `CreateUserService` runs its lookup and insert in one transaction. The PostgreSQL unique constraint remains authoritative for concurrent duplicate requests; the pre-check only provides an early domain-friendly conflict path.

## Failure semantics

- Returning from the callback commits.
- Throwing rejects and rolls back the complete unit of work.
- Repository `AppError`s propagate unchanged through the transaction manager.
- No automatic transaction retry is included; serialization/deadlock retry policy is a separate concern.

## Testing

- Service unit tests mock `TransactionManager` and repositories inside the supplied unit of work.
- Repository tests continue to use real PostgreSQL with factories.
- Transaction integration tests prove commit and rollback against PostgreSQL, including rollback after a unique-constraint failure.

## Non-goals

- Nested transaction/savepoint API.
- Automatic retries for serialization failures or deadlocks.
- AsyncLocalStorage/implicit transactions.
- A global unit of work containing every future repository.
