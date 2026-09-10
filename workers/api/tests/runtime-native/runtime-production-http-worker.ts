import {
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from '../../src/bootstrap';
import { routeRequest } from '../../src/http/router';
import { RateLimitDO } from '../../src/thread-do';
import { TelemetryDO } from '../../src/telemetry/telemetry-do';
import { ProductionThreadDO } from './runtime-production-worker';

export class ProductionHttpThreadDO extends ProductionThreadDO {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.configureRuntimeScenario('multi-turn');
  }
}

const handler = {
  async fetch(
    request: Request,
    env: BootstrapEnv,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    return routeRequest(
      request,
      createHttpRouterConfig(env, {
        ownership: createThreadScopeAuthorizer(env.THREADS),
        waitUntil: (promise) => executionContext.waitUntil(promise),
      }),
    );
  },
} satisfies ExportedHandler<BootstrapEnv>;

export { ProductionHttpThreadDO as ThreadDO, RateLimitDO, TelemetryDO };
export default handler;
