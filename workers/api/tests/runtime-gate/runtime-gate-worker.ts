import { getAgentByName } from 'agents';
import { RuntimeGateAgent } from './runtime-gate-agent';

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function agentName(url: URL): string {
  const requested = url.searchParams.get('agent');
  return requested === null
    ? 'runtime-gate-fixture'
    : safeName(requested) || 'runtime-gate-fixture';
}

function internalPath(url: URL, replay: boolean): string {
  if (replay) return '/replay';
  const prefix = '/v1/runtime-gate';
  if (url.pathname === prefix) return '/run';
  const suffix = url.pathname.slice(prefix.length);
  return suffix.length > 0 ? suffix : '/run';
}

export default {
  async fetch(request: Request, env: RuntimeGateEnv): Promise<Response> {
    const url = new URL(request.url);
    const isReplay = url.pathname === '/v1/runtime-gate/replay';
    const isRetention =
      url.pathname.startsWith('/v1/runtime-gate/') && url.pathname !== '/v1/runtime-gate/http';
    if (url.pathname !== '/v1/runtime-gate' && !isReplay && !isRetention) {
      return new Response('Not Found', { status: 404 });
    }

    const agent = await getAgentByName(env.RUNTIME_GATE, agentName(url));
    url.pathname = internalPath(url, isReplay);
    return agent.fetch(url, {
      method: request.method,
      headers: request.headers,
    });
  },
} satisfies ExportedHandler<RuntimeGateEnv>;

export { RuntimeGateAgent };
