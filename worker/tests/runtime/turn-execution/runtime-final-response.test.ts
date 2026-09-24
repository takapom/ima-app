import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import { createRuntimeFinalResponseHooks } from '@worker/runtime/turn-execution/runtime-final-response';

describe('runtime final-response gate', () => {
  it('enters final-only mode at the reserve boundary and consumes it once', () => {
    const budget = new RuntimeBudget({
      config: DEFAULT_RUNTIME_BUDGET,
      startedAtMs: 0,
      now: () => 10_500,
    });
    const hooks = createRuntimeFinalResponseHooks({ budget });

    const first = hooks.reserveModelStep(true);
    const second = hooks.reserveModelStep(true);

    expect(first).toEqual({ ok: true, value: undefined });
    expect(second).toMatchObject({ ok: false, denial: { code: 'BUDGET_EXCEEDED' } });
  });

  it('requires a tool on every step and offers only respond inside the final reserve', async () => {
    const hooksAt = (nowMs: number) =>
      createRuntimeFinalResponseHooks({
        budget: new RuntimeBudget({
          config: DEFAULT_RUNTIME_BUDGET,
          startedAtMs: 0,
          now: () => nowMs,
        }),
      });
    const call = (hooks: ReturnType<typeof hooksAt>, toolName: string) =>
      hooks.beforeToolCall({ toolName, toolCallId: 'call', input: {}, messages: [] } as never);

    // Outside the reserve every step is a normal step, including one after a refused respond.
    const early = hooksAt(1);
    expect(early.beforeStep({} as never)).toEqual({ toolChoice: 'required' });
    await expect(call(early, 'search_places')).resolves.toBeUndefined();

    const reserve = hooksAt(DEFAULT_RUNTIME_BUDGET.wholeTurnMs - 1_000);
    expect(reserve.beforeStep({} as never)).toEqual({
      activeTools: ['respond'],
      toolChoice: 'required',
    });
    await expect(call(reserve, 'search_places')).resolves.toMatchObject({ action: 'block' });
    await expect(call(reserve, 'respond')).resolves.toBeUndefined();
  });

  it('makes the last step final when the step count runs out before the time does', () => {
    const budget = new RuntimeBudget({
      config: DEFAULT_RUNTIME_BUDGET,
      startedAtMs: 0,
      now: () => 1,
    });
    const hooks = createRuntimeFinalResponseHooks({ budget });
    for (let step = 1; step < DEFAULT_RUNTIME_BUDGET.maxModelSteps; step += 1) {
      expect(hooks.beforeStep({} as never)).toEqual({ toolChoice: 'required' });
      expect(hooks.reserveModelStep(false)).toEqual({ ok: true, value: undefined });
    }
    // A read on the last step could never be followed by a respond.
    expect(hooks.beforeStep({} as never)).toEqual({
      activeTools: ['respond'],
      toolChoice: 'required',
    });
    expect(hooks.isFinalResponse({} as never)).toBe(true);
    expect(hooks.reserveModelStep(true)).toEqual({ ok: true, value: undefined });
  });
});
