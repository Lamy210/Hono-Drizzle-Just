import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { RequestContext } from "../../../core/context/request-context";
import { AppError } from "../../../core/errors/app-error";
import type { UserDeleteRepository } from "./user-delete.repository";

export class DeleteUserService {
  constructor(private readonly repository: UserDeleteRepository) {}

  async execute(id: string, context: RequestContext): Promise<void> {
    const { tenantId } = requireTenantScope(context, "users:write");
    const deleted = await this.repository.deleteById(
      tenantId,
      id.toLowerCase(),
    );
    if (!deleted) {
      throw new AppError("NOT_FOUND", "User not found", 404);
    }
  }
}
