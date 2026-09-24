import type { StepConfig, ToolCallContext, ToolCallDecision } from '@cloudflare/think';
import type { RuntimeBudget, RuntimeBudgetResult } from '@worker/runtime/budget/runtime-budget';
import type {
  RuntimeBeforeStepDelegate,
  RuntimeBeforeToolCallDelegate,
} from '@worker/runtime/turn-execution/runtime-turn-factory';
import type { RuntimeModelGuardCallOptions } from '@worker/runtime/turn-execution/runtime-model-guard';

type RuntimeFinalResponseOptions = {
  readonly budget: RuntimeBudget;
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
  readonly beforeToolCall?: RuntimeBeforeToolCallDelegate;
};

export type RuntimeFinalResponseHooks = {
  readonly beforeStep: RuntimeBeforeStepDelegate;
  readonly beforeToolCall: RuntimeBeforeToolCallDelegate;
  readonly isFinalResponse: (params: RuntimeModelGuardCallOptions) => boolean;
  readonly reserveModelStep: RuntimeBudget['reserveModelStep'];
};

const finalToolBlock: ToolCallDecision = {
  action: 'block',
  reason: 'final response mode permits only respond',
};

/**
 * Every step must call a tool; the final step may only respond. A committed respond ends the
 * loop through the budget's stop condition, so a refused respond leaves the next step a normal
 * repair step.
 */
const readStep = { toolChoice: 'required' as const };
const finalStep = { activeTools: ['respond'], toolChoice: 'required' as const };

const finalDenial = (): RuntimeBudgetResult<void> => ({
  ok: false,
  denial: {
    code: 'BUDGET_EXCEEDED',
    message: 'final response reserve was already consumed',
  },
});

export const createRuntimeFinalResponseHooks = (
  options: RuntimeFinalResponseOptions,
): RuntimeFinalResponseHooks => {
  let finalOnly = false;
  let finalReserved = false;

  const enterFinalReserve = (): boolean => {
    if (options.budget.checkAdmission(false)?.code === 'FINAL_RESERVE') finalOnly = true;
    return finalOnly;
  };

  const reserveModelStep: RuntimeBudget['reserveModelStep'] = (finalResponse = false) => {
    if (!finalResponse) return options.budget.reserveModelStep(false);
    if (finalReserved) return finalDenial();
    const result = options.budget.reserveModelStep(true);
    if (result.ok) finalReserved = true;
    return result;
  };

  const isFinalResponse = (params: RuntimeModelGuardCallOptions): boolean => {
    const selected = enterFinalReserve() || options.isFinalResponse?.(params) === true;
    if (selected) finalOnly = true;
    return selected;
  };

  const beforeStep: RuntimeBeforeStepDelegate = (): StepConfig | void => {
    enterFinalReserve();
    return finalOnly ? finalStep : readStep;
  };

  const beforeToolCall: RuntimeBeforeToolCallDelegate = async (
    context: ToolCallContext,
  ): Promise<ToolCallDecision | void> => {
    if (finalOnly && context.toolName !== 'respond') return finalToolBlock;
    return options.beforeToolCall?.(context);
  };

  return {
    beforeStep,
    beforeToolCall,
    isFinalResponse,
    reserveModelStep,
  };
};
