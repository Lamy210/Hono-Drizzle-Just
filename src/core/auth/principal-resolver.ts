import type { Principal } from "./principal";

export interface PrincipalResolutionInput {
  readonly authorization?: string;
  readonly cookie?: string;
}

export interface PrincipalResolver {
  resolve(input: PrincipalResolutionInput): Promise<Principal | undefined>;
}
