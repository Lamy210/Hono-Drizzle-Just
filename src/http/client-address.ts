export interface ClientAddressInput {
  readonly remoteAddress?: string;
  readonly xForwardedFor?: string;
}

export type ClientAddressResolver = (input: ClientAddressInput) => string | undefined;
