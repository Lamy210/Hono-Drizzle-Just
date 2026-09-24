import type { User } from "../domain/user";

export interface UserListCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface UserCursorListPage {
  readonly users: readonly User[];
  readonly hasMore: boolean;
}

export interface UserCursorListRepository {
  listAfter(
    tenantId: string,
    input: {
      readonly after?: UserListCursor;
      readonly limit: number;
    },
  ): Promise<UserCursorListPage>;
}
