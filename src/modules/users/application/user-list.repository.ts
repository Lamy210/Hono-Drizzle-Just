import type { User } from "../domain/user";

export interface UserListPage {
  readonly users: readonly User[];
  readonly total: number;
}

export interface UserListRepository {
  listPage(
    tenantId: string,
    input: { readonly offset: number; readonly limit: number },
  ): Promise<UserListPage>;
}
