import { getAgentByName } from 'agents';
import { normalizeThinkRuntimeReport, publicError } from '../runtime-gate/http/runtime-gate-http';
import { ThinkRuntimeGateAgent } from './think-runtime-agent';
import { normalizeThinkRuntimeReplayReport } from './think-runtime-replay-http';

type ThinkRuntimeEnv = Cloudflare.Env & {
  THINK_RUNTIME: DurableObjectNamespace<ThinkRuntimeGateAgent>;
};

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function agentName(url: URL): string {
  const requested = url.searchParams.get('id') ?? url.searchParams.get('agent');
  return requested === null
    ? 'think-runtime-fixture'
    : safeName(requested) || 'think-runtime-fixture';
}

function internalPath(url: URL): string {
  const prefix = '/v1/think-runtime';
  if (url.pathname === prefix) return '/run';
  const suffix = url.pathname.slice(prefix.length);
  if (suffix === '/http') return '/run';
  return suffix.length > 0 ? suffix : '/run';
}

export default {
  async fetch(request: Request, env: ThinkRuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    const prefix = '/v1/think-runtime';
    const isHttp = url.pathname === `${prefix}/http`;
    const isReplay = url.pathname === `${prefix}/replay`;
    const supportedPath = url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
    if (!supportedPath) {
      return new Response('Not Found', { status: 404 });
    }

    const agent = await getAgentByName(env.THINK_RUNTIME, agentName(url));
    url.pathname = internalPath(url);
    const report = await agent.fetch(url, { method: request.method, headers: request.headers });
    if (!isHttp && !isReplay) return report;
    if (request.method !== 'GET') return new Response('Not Found', { status: 404 });
    try {
      const body: unknown = await report.json();
      const revisionValue = Number(url.searchParams.get('revision') ?? '1');
      const revision =
        Number.isSafeInteger(revisionValue) && revisionValue >= 1 ? revisionValue : 1;
      const context = {
        threadId: url.searchParams.get('threadId') ?? 'thread-think-runtime',
        turnId: url.searchParams.get('turnId') ?? 'turn-think-runtime',
        revision,
      };
      return Response.json(
        isReplay
          ? normalizeThinkRuntimeReplayReport(body, context)
          : normalizeThinkRuntimeReport(body, context),
      );
    } catch (error) {
      return publicError(error);
    }
  },
} satisfies ExportedHandler<ThinkRuntimeEnv>;

export { ThinkRuntimeGateAgent };
