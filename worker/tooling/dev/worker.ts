import production from '@worker/platform/entrypoints/cloudflare/worker';
import { RateLimitDO } from '@worker/platform/entrypoints/cloudflare/thread-do';
import { TelemetryDO } from '@worker/infrastructure/adapters/out/persistence/telemetry/telemetry-do';
import { withDevCors } from './cors';

type ProductionFetch = NonNullable<typeof production.fetch>;

const fetch: ProductionFetch = (request, env, executionContext) => {
  const handler = () => production.fetch(request, env, executionContext);
  return withDevCors(request, env, handler);
};

export { ThreadDO } from '@worker/platform/entrypoints/cloudflare/thread-do';
export { RateLimitDO, TelemetryDO };
export default { fetch } satisfies { fetch: ProductionFetch };

export { ConversationHistoryDO } from '@worker/platform/entrypoints/cloudflare/conversation-history-do';
