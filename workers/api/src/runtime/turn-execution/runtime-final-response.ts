import type { StepConfig, ToolCallContext, ToolCallDecision } from '@cloudflare/think';
import type { RuntimeBudget, RuntimeBudgetResult } from '../budget/runtime-budget';
import type {
  RuntimeBeforeStepDelegate,
  RuntimeBeforeToolCallDelegate,
} from './runtime-turn-factory';
import type {
  RuntimeModelGuardAcceptance,
  RuntimeModelGuardCallOptions,
} from './runtime-model-guard';

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
  readonly accept: (acceptance: RuntimeModelGuardAcceptance) => void;
};

const finalToolBlock: ToolCallDecision = {
  action: 'block',
  reason: 'final response mode does not permit tool calls',
};

const finalStep = { activeTools: [] as string[], toolChoice: 'none' as const };

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
  let finalAccepted = false;

  const enterFinalReserve = (): boolean => {
    if (options.budget.checkAdmission(false)?.code === 'FINAL_RESERVE') finalOnly = true;
    return finalOnly;
  };

  const reserveModelStep: RuntimeBudget['reserveModelStep'] = (finalResponse = false) => {
    if (!finalResponse) return options.budget.reserveModelStep(false);
    if (finalReserved || finalAccepted) return finalDenial();
    const result = options.budget.reserveModelStep(true);
    if (result.ok) finalReserved = true;
    return result;
  };

  const isFinalResponse = (params: RuntimeModelGuardCallOptions): boolean => {
    const selected = enterFinalReserve() || options.isFinalResponse?.(params) === true;
    if (selected) finalOnly = true;
    return selected || finalAccepted;
  };

  const beforeStep: RuntimeBeforeStepDelegate = (): StepConfig | void => {
    enterFinalReserve();
    if (!finalOnly && !finalAccepted) return undefined;
    return finalStep;
  };

  const beforeToolCall: RuntimeBeforeToolCallDelegate = async (
    context: ToolCallContext,
  ): Promise<ToolCallDecision | void> => {
    if (finalOnly || finalAccepted) return finalToolBlock;
    return options.beforeToolCall?.(context);
  };

  return {
    beforeStep,
    beforeToolCall,
    isFinalResponse,
    reserveModelStep,
    accept: (acceptance) => {
      if (acceptance.terminal === 'message') finalAccepted = true;
    },
  };
};
