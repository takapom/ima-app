import { getAgentByName } from 'agents';
import { RuntimeGateAgent } from './runtime-gate-agent';
import { normalizeRuntimeGateReport, publicError } from './http/runtime-gate-http';

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function agentName(url: URL, http: boolean): string {
  if (http) return `runtime-gate-http-${safeName(url.searchParams.get('id') ?? 'default')}`;
  const requested = url.searchParams.get('agent');
  return requested === null
    ? 'runtime-gate-fixture'
    : safeName(requested) || 'runtime-gate-fixture';
}

function internalPath(url: URL, replay: boolean, http: boolean): string {
  if (replay) return '/replay';
  if (http) return '/run';
  const prefix = '/v1/runtime-gate';
  if (url.pathname === prefix) return '/run';
  const suffix = url.pathname.slice(prefix.length);
  return suffix.length > 0 ? suffix : '/run';
}

function queryValue(url: URL, name: string, fallback: string): string {
  const value = url.searchParams.get(name);
  return value === null ? fallback : value.slice(0, 128);
}

function queryRevision(url: URL): number {
  const value = Number(url.searchParams.get('revision') ?? '1');
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

export default {
  async fetch(request: Request, env: RuntimeGateEnv): Promise<Response> {
    const url = new URL(request.url);
    const isReplay = url.pathname === '/v1/runtime-gate/replay';
    const isHttp = url.pathname === '/v1/runtime-gate/http';
    const isRetention = url.pathname.startsWith('/v1/runtime-gate/');
    if (url.pathname !== '/v1/runtime-gate' && !isReplay && !isHttp && !isRetention) {
      return new Response('Not Found', { status: 404 });
    }

    const agent = await getAgentByName(env.RUNTIME_GATE, agentName(url, isHttp));
    url.pathname = internalPath(url, isReplay, isHttp);
    const report = await agent.fetch(url, {
      method: request.method,
      headers: request.headers,
    });
    if (!isHttp) return report;
    if (request.method !== 'GET') return new Response('Not Found', { status: 404 });

    try {
      const reportBody: unknown = await report.json();
      return Response.json(
        normalizeRuntimeGateReport(reportBody, {
          threadId: queryValue(url, 'threadId', 'thread-http-mobile'),
          turnId: queryValue(url, 'turnId', 'turn-runtime-gate'),
          revision: queryRevision(url),
        }),
      );
    } catch (error) {
      return publicError(error);
    }
  },
} satisfies ExportedHandler<RuntimeGateEnv>;

export { RuntimeGateAgent };
