import type { User } from "../domain/user";
import type { UserVersionPrecondition } from "./user-version-precondition";

export interface UserUpdateFields {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
}

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
