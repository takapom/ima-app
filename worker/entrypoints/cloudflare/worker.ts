import {
  createApplicationScopeAuthorizer,
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '@worker/composition/bootstrap';
import { routeRequest } from '@worker/adapters/inbound/http/router';
import {
  handleJourneyDatasetManagement,
  type JourneyDatasetNamespace,
} from '@worker/adapters/inbound/http/journey-dataset-management';
import { JourneyDatasetDO } from '@worker/adapters/outbound/persistence/last-train/dataset-do';
import { RateLimitDO, ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import { TelemetryDO } from '@worker/adapters/outbound/persistence/telemetry/telemetry-do';
import { AppIntegrityDO } from '@worker/adapters/outbound/persistence/security/app-integrity-do';

type IndexEnv = BootstrapEnv & {
  readonly JOURNEY_DATASETS?: JourneyDatasetNamespace;
  readonly JOURNEY_DATASET_ADMIN_TOKEN?: string;
};

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
    const managementResponse = await handleJourneyDatasetManagement(request, {
      ...(env.JOURNEY_DATASETS === undefined ? {} : { namespace: env.JOURNEY_DATASETS }),
      ...(env.JOURNEY_DATASET_ADMIN_TOKEN === undefined
        ? {}
        : { adminToken: env.JOURNEY_DATASET_ADMIN_TOKEN }),
    });
    if (managementResponse !== null) return managementResponse;
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

export { AppIntegrityDO, JourneyDatasetDO, RateLimitDO, TelemetryDO, ThreadDO };
export { SavedReferenceDO } from '@worker/adapters/outbound/persistence/saved-references/saved-reference-do';
