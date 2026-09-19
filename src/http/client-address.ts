export interface ClientAddressInput {
  readonly remoteAddress: string | undefined;
  readonly xForwardedFor: string | undefined;
}

export type ClientAddressResolver = (input: ClientAddressInput) => string | undefined;
