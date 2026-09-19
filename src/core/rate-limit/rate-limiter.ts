export interface RateLimitRequest {
  readonly scope: string;
  readonly identity: string;
}

export type RateLimitDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly retryAfterSeconds: number;
    };

export interface RateLimiter {
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}
