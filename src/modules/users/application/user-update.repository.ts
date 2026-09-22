import type { User } from "../domain/user";

export type UserUpdateFields =
  | { readonly email: string; readonly name?: string }
  | { readonly email?: string; readonly name: string };

export interface UserUpdateRepository {
  update(
    tenantId: string,
    id: string,
    fields: UserUpdateFields,
  ): Promise<User | null>;
}
