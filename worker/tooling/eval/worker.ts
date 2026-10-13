import * as v from 'valibot';
import {
  EvalCaseSchema,
  EvalFailureSchema,
  EvalRunResultSchema,
  type EvalCase,
  type EvalFailure,
  type EvalHealth,
  type EvalRunResult,
} from './eval-contract';
import { EvalThreadDO } from './eval-thread-do';

export type EvalWorkerEnv = {
  readonly EVAL_THREADS: DurableObjectNamespace<EvalThreadDO>;
  readonly OPENAI_API_KEY?: string;
  /** Providerが起動ごとに`--var`で渡す識別子。 */
  readonly EVAL_INSTANCE?: string;
};

const failure = (error: EvalFailure['error'], status: number): Response =>
  Response.json({ error } satisfies EvalFailure, { status });

const modelKeyConfigured = (env: EvalWorkerEnv): boolean =>
  typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim().length > 0;

const EvalOutcomeSchema = v.union([EvalRunResultSchema, EvalFailureSchema]);

const runCase = async (env: EvalWorkerEnv, evalCase: EvalCase): Promise<Response> => {
  const threadId = `eval-${crypto.randomUUID()}`;
  const raw = await env.EVAL_THREADS.getByName(threadId).runEvalCase(threadId, evalCase);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return failure('TURN_FAILED', 500);
  }
  // DOが返した記録も契約で検証し、形が崩れていれば成功として渡さない。
  const parsed = v.safeParse(EvalOutcomeSchema, body);
  if (!parsed.success) return failure('TURN_FAILED', 500);
  if ('error' in parsed.output) {
    return failure(parsed.output.error, parsed.output.error === 'UNKNOWN_SHOP_SET' ? 400 : 500);
  }
  return Response.json(parsed.output satisfies EvalRunResult);
};

const handleTurns = async (request: Request, env: EvalWorkerEnv): Promise<Response> => {
  if (!modelKeyConfigured(env)) return failure('OPENAI_API_KEY_MISSING', 503);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure('INVALID_CASE', 400);
  }
  const parsed = v.safeParse(EvalCaseSchema, body);
  if (!parsed.success) return failure('INVALID_CASE', 400);
  try {
    return await runCase(env, parsed.output);
  } catch (error: unknown) {
    // 原因の特定には名前で足りる。messageにはProviderの応答が含まれうるため出さない。
    console.error('eval turn failed', error instanceof Error ? error.name : 'unknown');
    return failure('TURN_FAILED', 500);
  }
};

/**
 * promptfoo専用のローカル入口。評価用Providerが`wrangler dev --local`で起動し、
 * デプロイするWorkerには含まれない。
 */
export default {
  fetch(request: Request, env: EvalWorkerEnv) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ready: true,
        modelKeyConfigured: modelKeyConfigured(env),
        instance: env.EVAL_INSTANCE ?? null,
      } satisfies EvalHealth);
    }
    if (request.method === 'POST' && url.pathname === '/turns') return handleTurns(request, env);
    return failure('NOT_FOUND', 404);
  },
} satisfies ExportedHandler<EvalWorkerEnv>;

export { EvalThreadDO };
