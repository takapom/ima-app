import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import {
  RUNTIME_MODEL_MAX_RETRIES,
  type RuntimeModelGuardAcceptance,
  type RuntimeModelGuardCallOptions,
  type RuntimeModelGuardModel,
  type RuntimeModelGuardStreamPart,
  wrapRuntimeModelGuard,
} from '@worker/runtime/turn-execution/runtime-model-guard';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} satisfies Extract<RuntimeModelGuardStreamPart, { type: 'finish' }>['usage'];

const streamOf = (
  parts: readonly RuntimeModelGuardStreamPart[],
): ReadableStream<RuntimeModelGuardStreamPart> =>
  new ReadableStream({
    start(controller) {
      parts.forEach((part) => controller.enqueue(part));
      controller.close();
    },
  });

const finalToolParts = (): RuntimeModelGuardStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id: 'final-search', toolName: 'search_places' },
  { type: 'tool-input-delta', id: 'final-search', delta: '{}' },
  { type: 'tool-input-end', id: 'final-search' },
  { type: 'tool-call', toolCallId: 'final-search', toolName: 'search_places', input: '{}' },
  { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
];

const respondParts = (): RuntimeModelGuardStreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id: 'final-respond', toolName: 'respond' },
  { type: 'tool-input-delta', id: 'final-respond', delta: '{}' },
  { type: 'tool-input-end', id: 'final-respond' },
  { type: 'tool-call', toolCallId: 'final-respond', toolName: 'respond', input: '{}' },
  { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: 'tool-calls' } },
];

const finalOnlyModel = (
  parts: () => RuntimeModelGuardStreamPart[] = finalToolParts,
): RuntimeModelGuardModel => ({
  specificationVersion: 'v3',
  provider: 'runtime-final-guard-fixture',
  modelId: 'runtime-final-guard-fixture',
  supportedUrls: {},
  doGenerate: () => Promise.reject(new Error('FINAL_GUARD_GENERATE_NOT_CONFIGURED')),
  doStream: (_options: RuntimeModelGuardCallOptions) =>
    Promise.resolve({ stream: streamOf(parts()) }),
});

const guarded = (
  parts?: () => RuntimeModelGuardStreamPart[],
  onAccepted?: (acceptance: RuntimeModelGuardAcceptance) => void,
): RuntimeModelGuardModel => {
  const budget = new RuntimeBudget({
    config: { ...DEFAULT_RUNTIME_BUDGET },
    startedAtMs: 0,
    now: () => 1,
  });
  return wrapRuntimeModelGuard(finalOnlyModel(parts), {
    budget,
    isFinalResponse: () => true,
    remainingTimeMs: () => DEFAULT_RUNTIME_BUDGET.wholeTurnMs,
    ...(onAccepted === undefined ? {} : { onAccepted }),
  });
};

describe('final-only runtime model guard', () => {
  it('accepts respond as the one tool a final-only step may call', async () => {
    const accepted: RuntimeModelGuardAcceptance[] = [];
    const model = guarded(respondParts, (acceptance) => accepted.push(acceptance));
    const result = await model.doStream({ prompt: [] });
    const reader = result.stream.getReader();
    while (!(await reader.read()).done) {
      // Drains the replayed step.
    }
    expect(accepted).toEqual([
      expect.objectContaining({ terminal: 'respond', missingRespond: null }),
    ]);
  });

  it('rejects read tools before the SDK executes a tool', async () => {
    const effects: string[] = [];
    const model = guarded();
    await expect(model.doStream({ prompt: [] })).rejects.toMatchObject({
      code: 'READ_IN_FINAL_STEP',
    });
    const generated = streamText({
      model,
      prompt: 'fixture final-only call',
      maxRetries: RUNTIME_MODEL_MAX_RETRIES,
      stopWhen: stepCountIs(1),
      tools: {
        search_places: tool<unknown, { ok: boolean }>({
          inputSchema: z.object({}),
          execute: () => {
            effects.push('search_places');
            return { ok: true };
          },
        }),
      },
    });

    await expect(generated.text).rejects.toBeDefined();
    expect(effects).toEqual([]);
  });
});
