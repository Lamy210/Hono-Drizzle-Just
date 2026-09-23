import type { UserVersionPrecondition } from "./user-version-precondition";

export type UserDeleteResult =
  | { readonly state: "deleted" }
  | { readonly state: "not_found" }
  | { readonly state: "precondition_failed" };

export interface UserDeleteRepository {
  deleteById(
    tenantId: string,
    id: string,
    precondition: UserVersionPrecondition,
  ): Promise<UserDeleteResult>;
}
