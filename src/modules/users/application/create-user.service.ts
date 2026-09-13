import { AppError } from "../../../core/errors/app-error";
import type { RequestContext } from "../../../core/context/request-context";
import type { Logger } from "../../../core/logging/logger";
import type { CreateUserInput, User } from "../domain/user";
import type { UserRepository } from "../domain/user.repository";

export class CreateUserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: CreateUserInput, context: RequestContext): Promise<User> {
    const normalized = {
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
    };
    const existing = await this.repository.findByEmail(normalized.email);
    if (existing) {
      throw new AppError("CONFLICT", "A user with this email already exists", 409);
    }

    const user = await this.repository.create(normalized);
    this.logger.info("user.created", {
      userId: user.id,
      requestId: context.requestId,
      traceId: context.trace.traceId,
    });
    return user;
  }
}
