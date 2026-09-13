import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '../../../src/runtime/runtime-budget';
import { createRuntimeFinalResponseHooks } from '../../../src/runtime/turn-execution/runtime-final-response';

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
});
