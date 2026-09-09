import {
  createHttpRouterConfig,
  createThreadScopeAuthorizer,
  type BootstrapEnv,
} from './bootstrap';
import { routeRequest } from './http/router';
import { RateLimitDO, ThreadDO } from './thread-do';

type HealthResponse = {
  readonly status: 'ok';
};

export default {
  async fetch(
    request: Request,
    env: BootstrapEnv,
    executionContext: ExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') {
      const body: HealthResponse = { status: 'ok' };
      return Response.json(body);
    }
    const ownership = createThreadScopeAuthorizer(env.THREADS);
    return routeRequest(
      request,
      createHttpRouterConfig(env, {
        ownership,
        waitUntil: (promise) => executionContext.waitUntil(promise),
      }),
    );
  },
} satisfies ExportedHandler<BootstrapEnv>;

export { RateLimitDO, ThreadDO };
