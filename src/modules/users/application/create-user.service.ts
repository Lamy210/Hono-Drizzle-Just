import type { RequestContext } from "../../../core/context/request-context";
import { AppError } from "../../../core/errors/app-error";
import type { Logger } from "../../../core/logging/logger";
import type { CreateUserInput, User } from "../domain/user";
import type { UserTransactionManager } from "./user-unit-of-work";

export class CreateUserService {
  constructor(
    private readonly transactions: UserTransactionManager,
    private readonly logger: Logger,
  ) {}

  async execute(input: CreateUserInput, context: RequestContext): Promise<User> {
    const normalized = {
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
    };

    const user = await this.transactions.run(async (unitOfWork) => {
      const existing = await unitOfWork.users.findByEmail(normalized.email);
      if (existing) {
        throw new AppError("CONFLICT", "A user with this email already exists", 409);
      }
      return unitOfWork.users.create(normalized);
    });

    this.logger.info("user.created", {
      userId: user.id,
      requestId: context.requestId,
      traceId: context.trace.traceId,
    });
    return user;
  }
}
