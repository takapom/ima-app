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
  SubmitCardsInvalid,
  SubmitCardsPort,
  TurnConditionValues,
} from '@ima/core';
import {
  observeRuntimeSubmitRejection,
  observeRuntimeTurnOutcome,
  type RuntimeSubmitRejectionWriter,
  type RuntimeTurnOutcomeWriter,
} from '@worker/infrastructure/runtime/turn-execution/runtime-submit-diagnostic';
import {
  isPublicToolName,
  PUBLIC_TOOL_NAMES,
  type PublicToolSet,
  type ToolBindingDependencies,
  type ToolRuntimeFactory,
  type PublicToolName,
} from '@worker/infrastructure/runtime/ports/tool-binding';
import type { RuntimeBudget } from '@worker/infrastructure/runtime/budget/runtime-budget';

const RUNTIME_MAX_RETRIES = 0;

type RuntimeStopWhen = Exclude<TurnConfig['stopWhen'], undefined>;

export type RuntimeTurnPortDependencies = Omit<ToolBindingDependencies, 'runtime'> & {
  /** Clears Worker-only per-turn handoffs when the composition is disposed. */
  readonly onTurnDispose?: () => void;
};

export type RuntimeTurnFactoryOptions = {
  readonly createTools: (dependencies: ToolBindingDependencies) => PublicToolSet;
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
  /** Observes rejected submits; the default writer logs the structural diagnostic. */
  readonly onSubmitRejected?: RuntimeSubmitRejectionWriter;
  /** Observes the turn's operation shape at dispose; the default writer logs it. */
  readonly onTurnOutcome?: RuntimeTurnOutcomeWriter;
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
  readonly hasUnresolvedSubmitFailure: () => boolean;
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

const THINK_WORKSPACE_TOOL_NAMES = [
  'bash',
  'delete',
  'edit',
  'find',
  'grep',
  'list',
  'read',
  'write',
] as const;

const isThinkWorkspaceToolName = (name: string): boolean =>
  THINK_WORKSPACE_TOOL_NAMES.some((workspaceName) => workspaceName === name);

const sameNames = (names: readonly string[]): boolean =>
  names.length === PUBLIC_TOOL_NAMES.length &&
  PUBLIC_TOOL_NAMES.every((name) => names.includes(name));

const cloneContext = (context: HarnessContext): HarnessContext => structuredClone(context);

const conditionsFromContext = (context: HarnessContext): TurnConditionValues => ({
  maxWalkMinutes: context.preferences.maxWalkMinutes,
  homeStationRef: context.preferences.homeStationRef,
  minimumStayMinutes: context.preferences.minimumStayMinutes,
});

/**
 * Keeps a model proposal from adopting a constraint no connected provider can
 * evidence. Such a constraint cannot be satisfied by any candidate, so accepting it
 * only spends the repair budget and commits nothing. The user's own stored settings
 * are never touched here: the rejected value is the model's suggestion for this turn.
 */
const supportedConditions = (
  capabilities: HarnessContext['capabilities'],
  current: TurnConditionValues,
  proposed: TurnConditionValues,
): TurnConditionValues => ({
  maxWalkMinutes: capabilities.walkingRoute ? proposed.maxWalkMinutes : current.maxWalkMinutes,
  homeStationRef: capabilities.lastTrain ? proposed.homeStationRef : current.homeStationRef,
  minimumStayMinutes: proposed.minimumStayMinutes,
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
}): SubmitCardsInvalid => {
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
  observeRejection: (result: SubmitCardsInvalid) => void,
  onCommitted: () => void,
): SubmitCardsPort => ({
  async submit(input, execution, cancellation) {
    const reservation = budget.reserveSubmit();
    if (!reservation.ok) {
      const result = submitDenial(reservation.denial);
      observeRejection(result);
      return result;
    }
    if (cancellation.isCancelled()) {
      return submitDenial({ code: 'CANCELLED', message: 'submit was cancelled' });
    }
    const result = await currentPort().submit(input, execution, cancellation);
    if (result.status === 'committed') {
      budget.markCommitted();
      onCommitted();
    } else observeRejection(result);
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
  const publicNames = names.filter(isPublicToolName);
  const hasUnexpectedTool = names.some(
    (name) => !isPublicToolName(name) && !isThinkWorkspaceToolName(name),
  );
  return !hasUnexpectedTool && sameNames(publicNames)
    ? undefined
    : new RuntimeTurnFactoryError('TOOL_SET_MISMATCH');
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
  const operationCounts = new Map<PublicToolName, number>();
  let committed = false;
  let unresolvedSubmitFailure = false;
  const reportSubmitRejection = (result: SubmitCardsInvalid): void => {
    unresolvedSubmitFailure = result.issues.some((issue) =>
      ['INVALID_ARGUMENT', 'SCHEMA_MISMATCH', 'BUDGET_EXCEEDED'].includes(issue.code),
    );
    observeRuntimeSubmitRejection(result, options.onSubmitRejected);
  };

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
      nextConditions = supportedConditions(
        baseContext.capabilities,
        conditions,
        applyTurnConstraintsForTurn(
          conditions,
          validatedMetadata.turnConstraints,
          options.constraintContext,
        ),
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
    operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1);
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
    reportSubmitRejection,
    () => {
      committed = true;
      unresolvedSubmitFailure = false;
    },
  );
  const dependencies: ToolBindingDependencies = Object.freeze({
    ...options.ports,
    submit,
    runtime,
    rejectSubmitInput: (result: SubmitCardsInvalid): SubmitCardsInvalid => {
      const reservation = options.budget.reserveSubmit();
      const rejected = reservation.ok
        ? {
            ...result,
            repairable: reservation.value.remainingRepairs > 0,
            remainingRepairs: reservation.value.remainingRepairs,
          }
        : submitDenial(reservation.denial);
      reportSubmitRejection(rejected);
      return rejected;
    },
  });
  const tools = options.createTools(dependencies);

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
    hasUnresolvedSubmitFailure: () => unresolvedSubmitFailure,
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
      const outcome = {
        committed,
        operations: Object.fromEntries(operationCounts),
      };
      if (options.onTurnOutcome === undefined) observeRuntimeTurnOutcome(outcome);
      else observeRuntimeTurnOutcome(outcome, options.onTurnOutcome);
      disposeController.abort();
      options.signal?.removeEventListener('abort', onParentAbort);
      serverCalls.clear();
      metadataByCall.clear();
      operationCounts.clear();
      options.budget.cancel();
      options.ports.onTurnDispose?.();
    },
  };
  return handle;
};
