import type { User } from "../domain/user";

export interface UserUpdateFields {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
}

export interface UserUpdateRepository {
  update(
    tenantId: string,
    id: string,
    fields: UserUpdateFields,
  ): Promise<User | null>;
}
