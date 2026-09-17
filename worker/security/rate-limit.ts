export type RateLimitRequest = {
  readonly route: string;
  readonly deviceId: string;
  readonly ownerScopeRef: string;
};

export type RateLimitResult = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number | null;
};

export interface RateLimiter {
  check(input: RateLimitRequest): Promise<RateLimitResult>;
}
