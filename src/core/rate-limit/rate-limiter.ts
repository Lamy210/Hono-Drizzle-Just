export interface RateLimitRequest {
  readonly scope: string;
  readonly identity: string;
}

export interface RateLimitQuota {
  readonly policyId: string;
  readonly limit: number;
  readonly remaining: number;
  readonly windowSeconds: number;
  readonly resetAfterSeconds: number;
}

export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly quota?: RateLimitQuota;
    }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
      readonly quota?: RateLimitQuota;
    };

export interface RateLimiter {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}
