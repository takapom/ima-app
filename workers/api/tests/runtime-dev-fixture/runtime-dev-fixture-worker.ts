import production from '../../src/index';
import { RateLimitDO, ThreadDO } from '../../src/thread-do';
import { TelemetryDO } from '../../src/telemetry/telemetry-do';
import { withDevFixtureCors } from './runtime-dev-fixture-cors';

type ProductionFetch = NonNullable<typeof production.fetch>;

const fetch: ProductionFetch = (request, env, executionContext) => {
  const handler = () => production.fetch(request, env, executionContext);
  return withDevFixtureCors(request, env, handler);
};

export { RateLimitDO, TelemetryDO, ThreadDO };
export default { fetch } satisfies { fetch: ProductionFetch };
