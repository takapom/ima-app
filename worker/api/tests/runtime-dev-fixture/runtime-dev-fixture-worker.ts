import production from '@api/index';
import { RateLimitDO } from '@api/thread-do';
import { TelemetryDO } from '@api/telemetry/telemetry-do';
import { withDevFixtureCors } from './runtime-dev-fixture-cors';

type ProductionFetch = NonNullable<typeof production.fetch>;

const fetch: ProductionFetch = (request, env, executionContext) => {
  const handler = () => production.fetch(request, env, executionContext);
  return withDevFixtureCors(request, env, handler);
};

export { ThreadDO } from './runtime-dev-llm';
export { RateLimitDO, TelemetryDO };
export default { fetch } satisfies { fetch: ProductionFetch };
