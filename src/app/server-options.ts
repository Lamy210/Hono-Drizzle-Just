export interface BunServerOptionsInput<TFetch> {
  readonly port: number;
  readonly fetch: TFetch;
  readonly maxRequestBodySize?: number;
}

export function createBunServerOptions<TFetch>(input: BunServerOptionsInput<TFetch>) {
  return {
    port: input.port,
    fetch: input.fetch,
  };
}
