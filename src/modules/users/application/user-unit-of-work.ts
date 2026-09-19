import type { TransactionManager } from "../../../core/transaction/transaction-manager";
import type { UserRepository } from "../domain/user.repository";
import type { UserCreationIdempotencyRepository } from "./user-creation-idempotency.repository";

export interface UserUnitOfWork {
  readonly users: UserRepository;
  readonly userCreationIdempotency: UserCreationIdempotencyRepository;
}

export type UserTransactionManager = TransactionManager<UserUnitOfWork>;
