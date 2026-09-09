import { getAgentByName } from 'agents';
import { ThinkGateAgent } from './think-gate-agent';

type ThinkGateEnv = Cloudflare.Env & {
  THINK_GATE: DurableObjectNamespace<ThinkGateAgent>;
};

export default {
  async fetch(request: Request, env: ThinkGateEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/think-gate') {
      return new Response('Not Found', { status: 404 });
    }

    const mode =
      url.searchParams.get('mode') === 'buffered-model'
        ? 'buffered-model'
        : url.searchParams.get('mode') === 'persistence-policy'
          ? 'persistence-policy'
          : 'raw-hooks';
    const agent = await getAgentByName(env.THINK_GATE, `think-gate-${mode}`);
    url.pathname = '/run';
    return agent.fetch(url, { method: request.method, headers: request.headers });
  },
} satisfies ExportedHandler<ThinkGateEnv>;

export { ThinkGateAgent };
