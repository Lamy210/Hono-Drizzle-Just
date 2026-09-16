import type { UserCreationIdempotencyRepository } from "../../src/modules/users/application/user-creation-idempotency.repository";
import type { UserUnitOfWork } from "../../src/modules/users/application/user-unit-of-work";
import type { UserRepository } from "../../src/modules/users/domain/user.repository";

export const unexpectedUserCreationIdempotency: UserCreationIdempotencyRepository = {
  claim: async () => {
    throw new Error("unexpected idempotency claim");
  },
  complete: async () => {
    throw new Error("unexpected idempotency completion");
  },
};

export function userUnitOfWork(
  users: UserRepository,
  userCreationIdempotency: UserCreationIdempotencyRepository = unexpectedUserCreationIdempotency,
): UserUnitOfWork {
  return { users, userCreationIdempotency };
}
