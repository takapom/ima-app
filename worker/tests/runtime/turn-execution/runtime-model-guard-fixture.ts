import { expect } from 'vitest';
import {
  DEFAULT_RUNTIME_BUDGET,
  RuntimeBudget,
  type RuntimeBudgetConfig,
} from '@worker/infrastructure/runtime/budget/runtime-budget';
import {
  wrapRuntimeModelGuard,
  type RuntimeModelGuardCallOptions,
  type RuntimeModelGuardError,
  type RuntimeModelGuardGenerateResult,
  type RuntimeModelGuardModel,
  type RuntimeModelGuardStreamPart,
} from '@worker/infrastructure/runtime/turn-execution/runtime-model-guard';

export type GenerateContent = RuntimeModelGuardGenerateResult['content'][number];

export const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} satisfies Extract<RuntimeModelGuardStreamPart, { type: 'finish' }>['usage'];

export const finish = (
  unified: 'stop' | 'tool-calls',
): Extract<RuntimeModelGuardStreamPart, { type: 'finish' }> => ({
  type: 'finish',
  usage,
  finishReason: { unified, raw: unified },
});

export const streamOf = (
  parts: readonly RuntimeModelGuardStreamPart[],
): ReadableStream<RuntimeModelGuardStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

export const toolParts = (
  toolName: string,
  id = `call-${toolName}`,
): RuntimeModelGuardStreamPart[] => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-delta', id, delta: '{}' },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: '{}' },
];

export const textParts = (text = 'done'): RuntimeModelGuardStreamPart[] => [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: text },
  { type: 'text-end', id: 'text-1' },
];

export const validFinal = (): RuntimeModelGuardStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  ...textParts(),
  finish('stop'),
];

export const budget = (
  overrides: Partial<RuntimeBudgetConfig> = {},
  options: { now?: () => number; isStale?: () => boolean; signal?: AbortSignal } = {},
): RuntimeBudget =>
  new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET, ...overrides },
    startedAtMs: 0,
    now: options.now ?? (() => 1),
    ...(options.isStale === undefined ? {} : { isStale: options.isStale }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

export type ModelScript = {
  readonly streamParts?: readonly RuntimeModelGuardStreamPart[];
  readonly generateResult?: RuntimeModelGuardGenerateResult;
  readonly pendingStream?: boolean;
  readonly calls: { stream: number; generate: number };
  readonly seenSignals: AbortSignal[];
};

export const modelFor = (script: ModelScript): RuntimeModelGuardModel => ({
  specificationVersion: 'v3',
  provider: 'runtime-model-guard-fixture',
  modelId: 'runtime-model-guard-fixture',
  supportedUrls: {},
  doGenerate: (options: RuntimeModelGuardCallOptions) => {
    script.calls.generate += 1;
    if (options.abortSignal !== undefined) script.seenSignals.push(options.abortSignal);
    if (script.generateResult === undefined) {
      return Promise.reject(new Error('RUNTIME_MODEL_GUARD_GENERATE_NOT_CONFIGURED'));
    }
    return Promise.resolve(script.generateResult);
  },
  doStream: (options: RuntimeModelGuardCallOptions) => {
    script.calls.stream += 1;
    if (options.abortSignal !== undefined) script.seenSignals.push(options.abortSignal);
    if (script.pendingStream === true) return new Promise(() => undefined);
    return Promise.resolve({ stream: streamOf(script.streamParts ?? validFinal()) });
  },
});

export const modelScript = (
  streamParts?: readonly RuntimeModelGuardStreamPart[],
  extra: Partial<Pick<ModelScript, 'generateResult' | 'pendingStream'>> = {},
): ModelScript =>
  streamParts === undefined
    ? { calls: { stream: 0, generate: 0 }, seenSignals: [], ...extra }
    : { streamParts, calls: { stream: 0, generate: 0 }, seenSignals: [], ...extra };

export const guarded = (
  script: ModelScript,
  options: Partial<Parameters<typeof wrapRuntimeModelGuard>[1]> = {},
): RuntimeModelGuardModel => {
  const turnBudget = budget();
  return wrapRuntimeModelGuard(modelFor(script), {
    budget: turnBudget,
    remainingTimeMs: (finalResponse) => turnBudget.remainingModelTimeMs(finalResponse),
    ...options,
  });
};

export const readAll = async (
  stream: ReadableStream<RuntimeModelGuardStreamPart>,
): Promise<void> => {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
      // The guard already performed the meaningful validation; this drains its replay stream.
    }
  } finally {
    reader.releaseLock();
  }
};

export const streamCall = (model: RuntimeModelGuardModel, signal?: AbortSignal) =>
  model.doStream({ prompt: [], ...(signal === undefined ? {} : { abortSignal: signal }) });

export const expectGuardCode = async (
  call: PromiseLike<unknown>,
  code: RuntimeModelGuardError['code'],
): Promise<void> => {
  await expect(call).rejects.toMatchObject({ code });
};
