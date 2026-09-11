import type { ModelEvalLiveCliCode } from './live-types';

export const LIVE_MODEL_VERSION = 'openai:gpt-5.6-luna' as const;
export const LIVE_PROMPT_VERSION = 'm25-production-default-v1' as const;

export type LiveOptIn =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly code: 'LIVE_FLAG_REQUIRED' | 'MODEL_PROVIDER_KEY_MISSING';
    };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const resolveModelEvalLiveOptIn = (env: unknown): LiveOptIn => {
  const values = record(env) ? env : {};
  if (values.MODEL_EVAL_LIVE !== '1' && values.MODEL_EVAL_LIVE !== 'true') {
    return { enabled: false, code: 'LIVE_FLAG_REQUIRED' };
  }
  if (typeof values.OPENAI_API_KEY !== 'string' || values.OPENAI_API_KEY.trim() === '') {
    return { enabled: false, code: 'MODEL_PROVIDER_KEY_MISSING' };
  }
  return { enabled: true };
};

/** Preflight only; the paid call is made by the dedicated Worker test, never this CLI. */
export const runModelEvalLiveCli = (
  args: readonly string[],
  environment: unknown,
  write: (line: string) => void,
): ModelEvalLiveCliCode => {
  if (!args.includes('--live')) {
    write(
      JSON.stringify({ mode: 'model-eval-live', status: 'skipped', code: 'LIVE_FLAG_REQUIRED' }),
    );
    return 2;
  }
  const optIn = resolveModelEvalLiveOptIn({
    ...(record(environment) ? environment : {}),
    MODEL_EVAL_LIVE: '1',
  });
  if (!optIn.enabled) {
    write(JSON.stringify({ mode: 'model-eval-live', status: 'skipped', code: optIn.code }));
    return 2;
  }
  write(
    JSON.stringify({
      mode: 'model-eval-live',
      status: 'worker-required',
      provider: 'openai',
      model: LIVE_MODEL_VERSION,
      costUsd: null,
    }),
  );
  return 2;
};
