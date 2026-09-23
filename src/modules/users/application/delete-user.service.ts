import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { RequestContext } from "../../../core/context/request-context";
import { AppError } from "../../../core/errors/app-error";
import type { Logger } from "../../../core/logging/logger";
import type { UserDeleteRepository } from "./user-delete.repository";

export class DeleteUserService {
  constructor(
    private readonly repository: UserDeleteRepository,
    private readonly logger: Logger,
  ) {}

  async execute(id: string, context: RequestContext): Promise<void> {
    const { tenantId } = requireTenantScope(context, "users:write");
    const canonicalId = id.toLowerCase();
    const deleted = await this.repository.deleteById(
      tenantId,
      canonicalId,
    );
    if (!deleted) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }

    this.logger.info("user.deleted", {
      userId: canonicalId,
      requestId: context.requestId,
      traceId: context.trace.traceId,
    });
  }
}
