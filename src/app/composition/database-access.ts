import type { UserUnitOfWork } from "../../modules/users/application/user-unit-of-work";
import { DrizzleUserRepository } from "../../modules/users/infrastructure/drizzle-user.repository";
import type { Database } from "../../infrastructure/database/database";
import type { DatabaseObserver } from "../../infrastructure/database/database-observer";
import { DrizzleTransactionManager } from "../../infrastructure/database/drizzle-transaction-manager";

export function createDatabaseAccess(database: Database, observer: DatabaseObserver) {
  const userRepository = new DrizzleUserRepository(database, observer);
  const userTransactions = new DrizzleTransactionManager<UserUnitOfWork>(
    database,
    (session) => ({ users: new DrizzleUserRepository(session, observer) }),
    observer,
  );

  return { userRepository, userTransactions };
}
