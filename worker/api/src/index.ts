import {
  createApplicationScopeAuthorizer,
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '@api/bootstrap';
import { routeRequest } from '@api/http/router';
import {
  handleJourneyDatasetManagement,
  type JourneyDatasetNamespace,
} from '@api/providers/last-train/management';
import { JourneyDatasetDO } from '@api/providers/last-train/dataset-do';
import { RateLimitDO, ThreadDO } from '@api/thread-do';
import { TelemetryDO } from '@api/telemetry/telemetry-do';
import { AppIntegrityDO } from '@api/security/app-integrity-do';

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
export { SavedReferenceDO } from '@api/saved-references/saved-reference-do';
