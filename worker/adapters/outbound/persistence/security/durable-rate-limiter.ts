import type { RateLimiter } from '@worker/security/rate-limit';
import type {
  RateLimitDO,
  RateLimitConfig,
  RateLimitCheckResult,
} from '@worker/adapters/outbound/persistence/security/rate-limit-do';

export class DurableRateLimiter implements RateLimiter {
  private static readonly bucketName = 'm05-rate-limit-v1';

  constructor(
    private readonly namespace: DurableObjectNamespace<RateLimitDO>,
    private readonly config: RateLimitConfig,
  ) {}

  check(input: Parameters<RateLimiter['check']>[0]): Promise<RateLimitCheckResult> {
    // One durable bucket keeps the device ceiling effective across owner scopes.
    return this.namespace.getByName(DurableRateLimiter.bucketName).check({
      ...input,
      config: this.config,
    });
  }
}
