import type { RateLimiter } from '@worker/security/rate-limit';
import type {
  RateLimitDO,
  RateLimitConfig,
  RateLimitCheckResult,
} from '@worker/adapters/out/persistence/security/rate-limit-do';

export class DurableRateLimiter implements RateLimiter {
  constructor(
    private readonly namespace: DurableObjectNamespace<RateLimitDO>,
    private readonly config: RateLimitConfig,
    private readonly bucketName = 'm05-rate-limit-v1',
  ) {}

  check(input: Parameters<RateLimiter['check']>[0]): Promise<RateLimitCheckResult> {
    // One durable bucket keeps the device ceiling effective across owner scopes.
    return this.namespace.getByName(this.bucketName).check({
      ...input,
      config: this.config,
    });
  }
}
