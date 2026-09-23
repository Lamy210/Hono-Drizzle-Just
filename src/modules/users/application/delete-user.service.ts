import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { RequestContext } from "../../../core/context/request-context";
import { AppError } from "../../../core/errors/app-error";
import type { Logger } from "../../../core/logging/logger";
import type { UserDeleteRepository } from "./user-delete.repository";
import type { UserVersionPrecondition } from "./user-version-precondition";

export class DeleteUserService {
  constructor(
    private readonly repository: UserDeleteRepository,
    private readonly logger: Logger,
  ) {}

  async execute(
    id: string,
    precondition: UserVersionPrecondition | undefined,
    context: RequestContext,
  ): Promise<void> {
    const { tenantId } = requireTenantScope(context, "users:write");
    if (precondition === undefined) {
      throw new AppError(
        "PRECONDITION_REQUIRED",
        "If-Match header is required",
        428,
      );
    }

    const canonicalId = id.toLowerCase();
    const result = await this.repository.deleteById(
      tenantId,
      canonicalId,
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

    this.logger.info("user.deleted", {
      userId: canonicalId,
      requestId: context.requestId,
      traceId: context.trace.traceId,
    });
  }
}
