export type UserVersionPrecondition =
  | { readonly kind: "any-current" }
  | { readonly kind: "versions"; readonly versions: readonly number[] };
