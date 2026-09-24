import type { UserUnitOfWork } from "../../modules/users/application/user-unit-of-work";
import { DrizzleUserCreationIdempotencyRepository } from "../../modules/users/infrastructure/drizzle-user-creation-idempotency.repository";
import { UserCreationIdempotencyCleanupGate } from "../../modules/users/infrastructure/user-creation-idempotency-cleanup-gate";
import type { UserCreationIdempotencyObserver } from "../../modules/users/infrastructure/user-creation-idempotency-observer";
import { DrizzleUserRepository } from "../../modules/users/infrastructure/drizzle-user.repository";
import type { Database } from "../../infrastructure/database/database";
import type { DatabaseObserver } from "../../infrastructure/database/database-observer";
import {
  DrizzleTransactionManager,
  type DrizzleTransactionManagerOptions,
} from "../../infrastructure/database/drizzle-transaction-manager";

export function createDatabaseAccess(
  database: Database,
  observer: DatabaseObserver,
  transactionOptions: DrizzleTransactionManagerOptions = {},
  idempotencyObserver?: UserCreationIdempotencyObserver,
) {
  const userRepository = new DrizzleUserRepository(database, observer);
  const idempotencyCleanupGate = new UserCreationIdempotencyCleanupGate();
  const userTransactions = new DrizzleTransactionManager<UserUnitOfWork>(
    database,
    (session) => ({
      users: new DrizzleUserRepository(session, observer),
      userCreationIdempotency: new DrizzleUserCreationIdempotencyRepository(
        session,
        observer,
        idempotencyCleanupGate,
        idempotencyObserver,
      ),
    }),
    observer,
    transactionOptions,
  );

  return { userRepository, userTransactions };
}
