import { getAgentByName } from 'agents';
import { ThinkRuntimeGateAgent } from './think-runtime-agent';

type ThinkRuntimeEnv = Cloudflare.Env & {
  THINK_RUNTIME: DurableObjectNamespace<ThinkRuntimeGateAgent>;
};

export default {
  async fetch(request: Request, env: ThinkRuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/think-runtime') {
      return new Response('Not Found', { status: 404 });
    }

    const agent = await getAgentByName(env.THINK_RUNTIME, 'think-runtime-fixture');
    url.pathname = '/run';
    return agent.fetch(url, { method: request.method, headers: request.headers });
  },
} satisfies ExportedHandler<ThinkRuntimeEnv>;

export { ThinkRuntimeGateAgent };
