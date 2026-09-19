export interface UserCreationIdempotencyRecord {
  readonly requestFingerprint: string;
  readonly userId: string | null;
}

export type UserCreationIdempotencyClaim =
  | { readonly state: "claimed" }
  | {
      readonly state: "existing";
      readonly record: UserCreationIdempotencyRecord;
    };

export interface UserCreationIdempotencyRepository {
  claim(input: {
    readonly tenantId: string;
    readonly keyHash: string;
    readonly requestFingerprint: string;
    readonly ttlSeconds: number;
  }): Promise<UserCreationIdempotencyClaim>;

  complete(input: {
    readonly tenantId: string;
    readonly keyHash: string;
    readonly requestFingerprint: string;
    readonly userId: string;
  }): Promise<void>;
}
