import {
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '@worker/composition/bootstrap';
import { routeRequest } from '@worker/adapters/inbound/http/router';
import { RateLimitDO } from '@worker/entrypoints/cloudflare/thread-do';
import { TelemetryDO } from '@worker/adapters/outbound/persistence/telemetry/telemetry-do';
import { SavedReferenceDO } from '@worker/adapters/outbound/persistence/saved-references/saved-reference-do';
import { ProductionThreadDO, RUNTIME_PRODUCTION_NOW } from './runtime-production-worker';

export class ProductionHttpThreadDO extends ProductionThreadDO {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.configureRuntimeScenario('multi-turn');
  }

  protected override photoReferenceNow(): string {
    return RUNTIME_PRODUCTION_NOW;
  }
}

const handler = {
  async fetch(
    request: Request,
    env: BootstrapEnv,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const photoClock = request.url.includes('/v1/photos/')
      ? () => RUNTIME_PRODUCTION_NOW
      : undefined;
    return routeRequest(
      request,
      createHttpRouterConfig(env, {
        ownership: createThreadScopeAuthorizer(env.THREADS),
        ...(photoClock === undefined ? {} : { clock: photoClock }),
        waitUntil: (promise) => executionContext.waitUntil(promise),
      }),
    );
  },
} satisfies ExportedHandler<BootstrapEnv>;

export { ProductionHttpThreadDO as ThreadDO, RateLimitDO, SavedReferenceDO, TelemetryDO };
export default handler;
