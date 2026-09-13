import type { TransactionManager } from "../../../core/transaction/transaction-manager";
import type { UserRepository } from "../domain/user.repository";

export interface UserUnitOfWork {
  readonly users: UserRepository;
}

export type UserTransactionManager = TransactionManager<UserUnitOfWork>;
