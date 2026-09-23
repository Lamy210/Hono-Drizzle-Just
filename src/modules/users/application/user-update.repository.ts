import type { User } from "../domain/user";

export interface UserUpdateFields {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
}

export type UserVersionPrecondition =
  | { readonly kind: "any-current" }
  | { readonly kind: "versions"; readonly versions: readonly number[] };

export type UserUpdateResult =
  | { readonly state: "updated"; readonly user: User }
  | { readonly state: "not_found" }
  | { readonly state: "precondition_failed" };

export interface UserUpdateRepository {
  update(
    tenantId: string,
    id: string,
    fields: UserUpdateFields,
    precondition: UserVersionPrecondition,
  ): Promise<UserUpdateResult>;
}
