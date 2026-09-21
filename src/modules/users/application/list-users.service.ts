import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { RequestContext } from "../../../core/context/request-context";
import type { User } from "../domain/user";
import type { UserListRepository } from "./user-list.repository";

export interface ListUsersInput {
  readonly page: number;
  readonly perPage: number;
}

export interface ListUsersResult {
  readonly users: readonly User[];
  readonly meta: {
    readonly page: number;
    readonly perPage: number;
    readonly total: number;
    readonly totalPages: number;
  };
}

export class ListUsersService {
  constructor(private readonly repository: UserListRepository) {}

  async execute(input: ListUsersInput, context: RequestContext): Promise<ListUsersResult> {
    const { tenantId } = requireTenantScope(context, "users:read");
    const offset = (input.page - 1) * input.perPage;
    const result = await this.repository.listPage(tenantId, {
      offset,
      limit: input.perPage,
    });

    return {
      users: result.users,
      meta: {
        page: input.page,
        perPage: input.perPage,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / input.perPage),
      },
    };
  }
}
