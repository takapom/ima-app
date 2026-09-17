import production from '@worker/entrypoints/cloudflare/worker';
import { RateLimitDO } from '@worker/entrypoints/cloudflare/thread-do';
import { TelemetryDO } from '@worker/adapters/outbound/persistence/telemetry/telemetry-do';
import { withDevFixtureCors } from './runtime-dev-fixture-cors';

type ProductionFetch = NonNullable<typeof production.fetch>;

const fetch: ProductionFetch = (request, env, executionContext) => {
  const handler = () => production.fetch(request, env, executionContext);
  return withDevFixtureCors(request, env, handler);
};

export { ThreadDO } from './runtime-dev-llm';
export { RateLimitDO, TelemetryDO };
export default { fetch } satisfies { fetch: ProductionFetch };
