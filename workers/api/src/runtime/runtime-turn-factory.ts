import type {
  PrepareStepContext,
  StepConfig,
  ToolCallContext,
  ToolCallDecision,
  TurnConfig,
  TurnContext,
} from '@cloudflare/think';
import { applyTurnConstraintsForTurn, validateModelActionMetadata } from '@ima/core';
import type {
  ConstraintValidationContext,
  HarnessContext,
  IdPort,
  ModelActionMetadata,
  SubmitCardsPort,
  SubmitCardsPortResult,
  TurnConditionValues,
} from '@ima/core';
import {
  createPublicToolSet,
  isPublicToolName,
  PUBLIC_TOOL_NAMES,
  type PublicToolSet,
  type ToolBindingDependencies,
  type ToolRuntimeFactory,
  type PublicToolName,
} from '../tools';
import type { RuntimeBudget } from './runtime-budget';

const RUNTIME_MAX_RETRIES = 0;

type RuntimeStopWhen = Exclude<TurnConfig['stopWhen'], undefined>;

export type RuntimeTurnPortDependencies = Omit<ToolBindingDependencies, 'runtime'>;

export type RuntimeTurnFactoryOptions = {
  /** The server-owned context is cloned when the turn factory is created. */
  readonly context: HarnessContext;
  readonly budget: RuntimeBudget;
  readonly ids: Pick<IdPort, 'nextCallId'>;
  readonly ports: RuntimeTurnPortDependencies;
  /** Rebuilds the submit adapter with the current clock and effective conditions for each call. */
  readonly buildSubmitPort?: (input: {
    readonly now: string;
    readonly conditions: TurnConditionValues;
  }) => SubmitCardsPort;
  /** Original user turns used by Core to validate quoted turn-constraint proposals. */
  readonly constraintContext: ConstraintValidationContext;
  /** M07 applies validated metadata and the resulting effective conditions to this turn. */
  readonly applyMetadata: (metadata: ModelActionMetadata, conditions: TurnConditionValues) => void;
  readonly signal?: AbortSignal;
  readonly isStale?: () => boolean;
  readonly beforeTurn?: RuntimeBeforeTurnDelegate;
  readonly beforeStep?: RuntimeBeforeStepDelegate;
  readonly beforeToolCall?: RuntimeBeforeToolCallDelegate;
  /** Supplied by the model guard so successful commit can stop the native loop. */
  readonly stopWhen: RuntimeStopWhen;
  /** Supplied by the retention adapter; no persistence policy is created here. */
  readonly experimentalTransform?: TurnConfig['experimental_transform'];
};

export type RuntimeBeforeTurnDelegate = (
  context: TurnContext,
) => TurnConfig | void | Promise<TurnConfig | void>;

export type RuntimeBeforeStepDelegate = (
  context: PrepareStepContext,
) => StepConfig | void | Promise<StepConfig | void>;

export type RuntimeBeforeToolCallDelegate = (
  context: ToolCallContext,
) => ToolCallDecision | void | Promise<ToolCallDecision | void>;

export type RuntimeThinkHooks = {
  readonly beforeTurn: RuntimeBeforeTurnDelegate;
  readonly beforeStep: RuntimeBeforeStepDelegate;
  readonly beforeToolCall: RuntimeBeforeToolCallDelegate;
};

export type RuntimeTurnHandle = {
  /** Base preferences remain unchanged; use `context`/`getConditions` for this turn's values. */
  readonly baseContext: HarnessContext;
  readonly context: HarnessContext;
  readonly getConditions: () => TurnConditionValues;
  /** Applies one already parsed metadata envelope through the same turn update path as Tools. */
  readonly applyMetadata: (metadata: ModelActionMetadata) => ModelActionMetadata;
  readonly budget: RuntimeBudget;
  readonly signal: AbortSignal;
  readonly dependencies: ToolBindingDependencies;
  readonly tools: PublicToolSet;
  readonly hooks: RuntimeThinkHooks;
  readonly isDisposed: () => boolean;
  readonly dispose: () => void;
};

export class RuntimeTurnFactoryError extends Error {
  readonly code: 'DISPOSED' | 'CANCELLED' | 'STALE_TURN' | 'TOOL_SET_MISMATCH' | 'CALL_ID_CONFLICT';

  constructor(code: RuntimeTurnFactoryError['code']) {
    super(`runtime turn factory denied: ${code}`);
    this.name = 'RuntimeTurnFactoryError';
    this.code = code;
  }
}

const sameNames = (names: readonly string[]): boolean =>
  names.length === PUBLIC_TOOL_NAMES.length &&
  PUBLIC_TOOL_NAMES.every((name) => names.includes(name));

const cloneContext = (context: HarnessContext): HarnessContext => structuredClone(context);

const conditionsFromContext = (context: HarnessContext): TurnConditionValues => ({
  maxWalkMinutes: context.preferences.maxWalkMinutes,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
});

const contextWithConditions = (
  base: HarnessContext,
  conditions: TurnConditionValues,
): HarnessContext => {
  const next = cloneContext(base);
  next.preferences = {
    ...next.preferences,
    maxWalkMinutes: conditions.maxWalkMinutes,
    homeStationRef: conditions.homeStationRef,
    minimumStayMinutes: conditions.minimumStayMinutes,
  };
  return next;
};

const budgetRepairCount = (budget: RuntimeBudget): 0 | 1 | 2 => {
  const remaining = budget.snapshot().remainingRepairs;
  if (remaining === 0 || remaining === 1 || remaining === 2) return remaining;
  return 0;
};

const submitDenial = (denial: {
  readonly code: string;
  readonly message: string;
}): SubmitCardsPortResult => {
  const code =
    denial.code === 'CANCELLED'
      ? ('CANCELLED' as const)
      : denial.code === 'STALE_TURN'
        ? ('STALE_TURN' as const)
        : ('BUDGET_EXCEEDED' as const);
  return {
    status: 'invalid',
    issues: [{ code, path: 'submit', message: denial.message, missingFields: [] }],
    repairable: false,
    remainingRepairs: 0,
  };
};

const budgetedSubmit = (
  currentPort: () => SubmitCardsPort,
  budget: RuntimeBudget,
): SubmitCardsPort => ({
  async submit(input, execution, cancellation) {
    const reservation = budget.reserveSubmit();
    if (!reservation.ok) return submitDenial(reservation.denial);
    if (cancellation.isCancelled()) {
      return submitDenial({ code: 'CANCELLED', message: 'submit was cancelled' });
    }
    const result = await currentPort().submit(input, execution, cancellation);
    if (result.status === 'committed') budget.markCommitted();
    return result;
  },
});

const factoryErrorCode = (
  disposed: boolean,
  stale: (() => boolean) | undefined,
): RuntimeTurnFactoryError['code'] =>
  disposed ? 'DISPOSED' : stale?.() === true ? 'STALE_TURN' : 'CANCELLED';

const toolSetMismatch = (context: TurnContext): RuntimeTurnFactoryError | undefined => {
  const names = Object.keys(context.tools);
  return sameNames(names) ? undefined : new RuntimeTurnFactoryError('TOOL_SET_MISMATCH');
};

/**
 * Creates the per-turn boundary consumed by a Think subclass.
 *
 * This is an adapter, not an agent loop: Think owns model steps and tool dispatch. The adapter
 * supplies one immutable server context, server call IDs, cancellation, metadata application,
 * and the exact public tool set. Model reservation/buffering and retention projection remain
 * injected delegates owned by their respective runtime units.
 */
export const createRuntimeTurnFactory = (options: RuntimeTurnFactoryOptions): RuntimeTurnHandle => {
  const baseContext = cloneContext(options.context);
  let context = cloneContext(baseContext);
  let conditions = conditionsFromContext(baseContext);
  const disposeController = new AbortController();
  let disposed = false;
  const serverCalls = new Map<
    string,
    {
      readonly operation: PublicToolName;
      readonly callId: string;
      readonly context: HarnessContext;
    }
  >();
  const metadataByCall = new Map<string, string>();

  const onParentAbort = (): void => {
    disposeController.abort();
    options.budget.cancel();
  };
  if (options.signal?.aborted === true) {
    onParentAbort();
  } else {
    options.signal?.addEventListener('abort', onParentAbort, { once: true });
  }

  const isCancelled = (invocationSignal?: AbortSignal): boolean =>
    disposed ||
    disposeController.signal.aborted ||
    options.signal?.aborted === true ||
    invocationSignal?.aborted === true ||
    options.isStale?.() === true ||
    options.budget.isCancelled();

  const applyMetadataToTurn = (metadata: ModelActionMetadata): ModelActionMetadata => {
    if (isCancelled())
      throw new RuntimeTurnFactoryError(factoryErrorCode(disposed, options.isStale));
    const validatedMetadata = validateModelActionMetadata(metadata, options.constraintContext);
    let nextConditions = conditions;
    if (validatedMetadata.turnConstraints !== undefined) {
      nextConditions = applyTurnConstraintsForTurn(
        conditions,
        validatedMetadata.turnConstraints,
        options.constraintContext,
      );
    }
    options.applyMetadata(validatedMetadata, nextConditions);
    conditions = nextConditions;
    context = contextWithConditions(baseContext, conditions);
    return validatedMetadata;
  };

  const runtime: ToolRuntimeFactory = (operation, invocation, metadata) => {
    if (isCancelled(invocation.abortSignal)) {
      throw new RuntimeTurnFactoryError(factoryErrorCode(disposed, options.isStale));
    }
    const metadataJson = JSON.stringify(metadata);
    const prior = serverCalls.get(invocation.toolCallId);
    if (prior !== undefined) {
      if (
        prior.operation !== operation ||
        metadataByCall.get(invocation.toolCallId) !== metadataJson
      ) {
        throw new RuntimeTurnFactoryError('CALL_ID_CONFLICT');
      }
      return {
        context: cloneContext(prior.context),
        execution: {
          callId: prior.callId,
          operation,
          threadId: prior.context.threadId,
          turnId: prior.context.turnId,
          revision: prior.context.revision,
        },
        cancellation: {
          isCancelled: (): boolean => isCancelled(invocation.abortSignal),
        },
        remainingRepairs: budgetRepairCount(options.budget),
      };
    }
    applyMetadataToTurn(metadata);
    const callId = options.ids.nextCallId();
    if (isCancelled(invocation.abortSignal)) {
      throw new RuntimeTurnFactoryError(factoryErrorCode(disposed, options.isStale));
    }
    const callContext = cloneContext(context);
    serverCalls.set(invocation.toolCallId, { operation, callId, context: callContext });
    metadataByCall.set(invocation.toolCallId, metadataJson);
    return {
      context: cloneContext(callContext),
      execution: {
        callId,
        operation,
        threadId: context.threadId,
        turnId: context.turnId,
        revision: context.revision,
      },
      cancellation: {
        isCancelled: (): boolean => isCancelled(invocation.abortSignal),
      },
      remainingRepairs: budgetRepairCount(options.budget),
    };
  };

  const submit = budgetedSubmit(
    () =>
      options.buildSubmitPort?.({
        now: options.ports.clock(),
        conditions: { ...conditions },
      }) ?? options.ports.submit,
    options.budget,
  );
  const dependencies: ToolBindingDependencies = Object.freeze({
    ...options.ports,
    submit,
    runtime,
  });
  const tools = createPublicToolSet(dependencies);

  const hooks: RuntimeThinkHooks = {
    beforeTurn: async (turnContext) => {
      const mismatch = toolSetMismatch(turnContext);
      if (mismatch !== undefined) throw mismatch;
      if (isCancelled()) {
        throw new RuntimeTurnFactoryError(factoryErrorCode(disposed, options.isStale));
      }
      const delegated = await options.beforeTurn?.(turnContext);
      if (delegated?.tools !== undefined && Object.keys(delegated.tools).length > 0) {
        throw new RuntimeTurnFactoryError('TOOL_SET_MISMATCH');
      }
      return {
        ...(delegated ?? {}),
        stopWhen: options.stopWhen,
        ...(options.experimentalTransform === undefined
          ? {}
          : { experimental_transform: options.experimentalTransform }),
        activeTools: [...PUBLIC_TOOL_NAMES],
        maxSteps: options.budget.limits.maxModelSteps,
        maxRetries: RUNTIME_MAX_RETRIES,
      };
    },
    beforeStep: async (stepContext) => {
      if (isCancelled()) {
        throw new RuntimeTurnFactoryError(factoryErrorCode(disposed, options.isStale));
      }
      return options.beforeStep?.(stepContext);
    },
    beforeToolCall: async (toolContext) => {
      if (!isPublicToolName(toolContext.toolName)) {
        return { action: 'block', reason: 'tool is outside the public runtime catalog' };
      }
      if (isCancelled(toolContext.abortSignal)) {
        return {
          action: 'block',
          reason: options.isStale?.() === true ? 'turn revision is stale' : 'turn was cancelled',
        };
      }
      return options.beforeToolCall?.(toolContext);
    },
  };

  const handle: RuntimeTurnHandle = {
    get baseContext() {
      return cloneContext(baseContext);
    },
    get context() {
      return cloneContext(context);
    },
    getConditions: () => ({ ...conditions }),
    applyMetadata: applyMetadataToTurn,
    budget: options.budget,
    signal: disposeController.signal,
    dependencies,
    tools,
    hooks,
    isDisposed: () => disposed,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeController.abort();
      options.signal?.removeEventListener('abort', onParentAbort);
      serverCalls.clear();
      metadataByCall.clear();
      options.budget.cancel();
    },
  };
  return handle;
};
