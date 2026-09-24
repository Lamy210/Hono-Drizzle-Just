import { requireTenantScope } from "../../../core/auth/tenant-authorization";
import type { RequestContext } from "../../../core/context/request-context";
import type { User } from "../domain/user";
import type {
  UserCursorListRepository,
  UserListCursor,
} from "./user-cursor-list.repository";

export interface ListUsersCursorInput {
  readonly after?: UserListCursor;
  readonly limit: number;
}

export interface ListUsersCursorResult {
  readonly users: readonly User[];
  readonly meta: {
    readonly limit: number;
    readonly next?: UserListCursor;
  };
}

export class ListUsersCursorService {
  constructor(private readonly repository: UserCursorListRepository) {}

  async execute(
    input: ListUsersCursorInput,
    context: RequestContext,
  ): Promise<ListUsersCursorResult> {
    const { tenantId } = requireTenantScope(context, "users:read");
    const result = await this.repository.listAfter(tenantId, input);
    const last = result.users.at(-1);

    return {
      users: result.users,
      meta: {
        limit: input.limit,
        ...(result.hasMore && last
          ? { next: { createdAt: last.createdAt, id: last.id } }
          : {}),
      },
    };
  }
}
