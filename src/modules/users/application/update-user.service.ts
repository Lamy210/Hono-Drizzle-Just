import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { RequestContext } from "../../../core/context/request-context";
import { AppError } from "../../../core/errors/app-error";
import type { Logger } from "../../../core/logging/logger";
import type { User } from "../domain/user";
import type {
  UserUpdateFields,
  UserUpdateRepository,
  UserVersionPrecondition,
} from "./user-update.repository";

export class UpdateUserService {
  constructor(
    private readonly repository: UserUpdateRepository,
    private readonly logger: Logger,
  ) {}

  async execute(
    id: string,
    input: UserUpdateFields,
    precondition: UserVersionPrecondition,
    context: RequestContext,
  ): Promise<User> {
    const { tenantId } = requireTenantScope(context, "users:write");
    if (input.email === undefined && input.name === undefined) {
      throw new AppError("VALIDATION_ERROR", "At least one user field is required", 400);
    }

    const normalized: UserUpdateFields = {
      ...(input.email === undefined
        ? {}
        : { email: input.email.trim().toLowerCase() }),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
    };

    const result = await this.repository.update(
      tenantId,
      id.toLowerCase(),
      normalized,
      precondition,
    );
    if (result.state === "not_found") {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
    if (result.state === "precondition_failed") {
      throw new AppError(
        "PRECONDITION_FAILED",
        "The user changed since it was last retrieved",
        412,
      );
    }

    const user = result.user;
    this.logger.info("user.updated", {
      userId: user.id,
      requestId: context.requestId,
      traceId: context.trace.traceId,
    });
    return user;
  }
}
