import production from '@worker/entrypoints/cloudflare/worker';
import { RateLimitDO } from '@worker/entrypoints/cloudflare/thread-do';
import { TelemetryDO } from '@worker/adapters/out/persistence/telemetry/telemetry-do';
import { withDevCors } from './cors';

type ProductionFetch = NonNullable<typeof production.fetch>;

const fetch: ProductionFetch = (request, env, executionContext) => {
  const handler = () => production.fetch(request, env, executionContext);
  return withDevCors(request, env, handler);
};

export { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
export { RateLimitDO, TelemetryDO };
export default { fetch } satisfies { fetch: ProductionFetch };

export { ConversationHistoryDO } from '@worker/entrypoints/cloudflare/conversation-history-do';
