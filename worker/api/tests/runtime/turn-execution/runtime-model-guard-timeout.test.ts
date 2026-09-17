import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeBudget } from '../../../src/runtime/budget/runtime-budget';
import {
  isRuntimeModelGuardError,
  wrapRuntimeModelGuard,
  type RuntimeModelGuardModel,
  type RuntimeModelGuardStreamPart,
} from '../../../src/runtime/turn-execution/runtime-model-guard';

const parts: RuntimeModelGuardStreamPart[] = [
  { type: 'tool-call', toolCallId: 'search-call', toolName: 'search_places', input: '{}' },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  },
];

const fixture = (budget: RuntimeBudget, delayMs?: number, finalResponse = false) => {
  let signal: AbortSignal | undefined;
  const cancel = vi.fn();
  const accepted = vi.fn();
  const provider: RuntimeModelGuardModel = {
    specificationVersion: 'v3',
    provider: 'timeout-test',
    modelId: 'timeout-test',
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error('UNUSED_GENERATE')),
    doStream: (options) => {
      signal = options.abortSignal;
      if (delayMs === undefined) {
        return Promise.resolve({ stream: new ReadableStream({ cancel }) });
      }
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              stream: new ReadableStream({
                start(controller) {
                  parts.forEach((part) => controller.enqueue(part));
                  controller.close();
                },
              }),
            }),
          delayMs,
        );
      });
    },
  };
  const model = wrapRuntimeModelGuard(provider, {
    budget,
    remainingTimeMs: (final) => budget.remainingModelTimeMs(final),
    isFinalResponse: () => finalResponse,
    onAccepted: accepted,
  });
  return {
    call: () =>
      Promise.resolve(model.doStream({ prompt: [] })).then(
        () => 'ok',
        (error: unknown) => {
          if (isRuntimeModelGuardError(error)) return error.code;
          throw error;
        },
      ),
    aborted: () => signal?.aborted,
    cancel,
    accepted,
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('default model and turn time budgets', () => {
  it('allows sequential inference and a model response longer than ten seconds', async () => {
    const budget = new RuntimeBudget({ startedAtMs: 0, now: Date.now });
    for (const duration of [3_500, 7_000, 12_000]) {
      const step = fixture(budget, duration);
      const pending = step.call();
      await vi.advanceTimersByTimeAsync(duration - 1);
      expect(step.accepted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('ok');
      expect(step.accepted).toHaveBeenCalledOnce();
      expect(step.aborted()).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(budget.snapshot().modelSteps).toBe(3);
  });

  it('still cancels a stalled model call at thirty seconds', async () => {
    const step = fixture(new RuntimeBudget({ startedAtMs: 0, now: Date.now }));
    const pending = step.call();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(step.aborted()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('MODEL_STREAM_TIMEOUT');
    expect(step.aborted()).toBe(true);
    expect(step.cancel).toHaveBeenCalledOnce();
    expect(step.accepted).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'clips the call timeout to the remaining turn budget (final: %s)',
    async (final) => {
      const budget = new RuntimeBudget({ startedAtMs: 0, now: Date.now });
      await vi.advanceTimersByTimeAsync(final ? 59_000 : 49_000);
      const step = fixture(budget, undefined, final);
      const pending = step.call();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toBe('MODEL_STREAM_TIMEOUT');
      expect(step.aborted()).toBe(true);
      expect(step.cancel).toHaveBeenCalledOnce();
    },
  );
});
