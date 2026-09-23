import {
  createApplicationScopeAuthorizer,
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '@worker/composition/bootstrap';
import { routeRequest } from '@worker/adapters/in/http/router';
import { RateLimitDO, ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import { TelemetryDO } from '@worker/adapters/out/persistence/telemetry/telemetry-do';
import { AppIntegrityDO } from '@worker/adapters/out/persistence/security/app-integrity-do';

type IndexEnv = BootstrapEnv;

type HealthResponse = {
  readonly status: 'ok';
};

export default {
  async fetch(
    request: Request,
    env: IndexEnv,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      const body: HealthResponse = { status: 'ok' };
      return Response.json(body);
    }
    const ownership = createApplicationScopeAuthorizer(
      createThreadScopeAuthorizer(env.THREADS),
      env.SAVED_REFERENCES,
    );
    return routeRequest(
      request,
      createHttpRouterConfig(env, {
        ownership,
        waitUntil: (promise) => executionContext.waitUntil(promise),
      }),
    );
  },
} satisfies ExportedHandler<IndexEnv>;

export { AppIntegrityDO, RateLimitDO, TelemetryDO, ThreadDO };
export { SavedReferenceDO } from '@worker/adapters/out/persistence/saved-references/saved-reference-do';

export { ConversationHistoryDO } from '@worker/entrypoints/cloudflare/conversation-history-do';
