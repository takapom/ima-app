import type { PrepareStepContext, Session, TurnConfig } from '@cloudflare/think';
import type { ToolSet } from 'ai';
import type { AssistantResponse } from '@ima/contracts';
import type {
  CandidateObservationRegistryPort,
  ClockPort,
  CommitHashPort,
  CommitPort,
  CommittedResponse,
  ConstraintValidationContext,
  HarnessContext,
  IdPort,
  ModelActionMetadata,
  ModelContextSource,
  SubmitCardsPort,
  SubmitValidationContext,
  TurnConditionValues,
} from '@ima/core';
import { projectModelContext, SubmitApplication, createSubmitCardsPort } from '@ima/core';
import { encodeModelContext } from '../model/encoding';
import type {
  RuntimeThinkComposition,
  RuntimeThinkPersistMessages,
  RuntimeThinkTurnBuildRequest,
} from './runtime-think-connection';
import {
  projectRuntimeCurrentTurnMessages,
  type RuntimeRetentionModelProjectionOptions,
} from './runtime-retention-model';
import {
  captureRuntimeEphemeralToolCall,
  captureRuntimeEphemeralToolResult,
  cloneRuntimeJsonValue,
  sanitizeRuntimeCompactionSummary,
  type RuntimeRetentionContext,
  type RuntimeRetentionEphemeralToolCall,
  type RuntimeRetentionEphemeralToolResult,
  type RuntimeRetentionScopeIdentity,
} from './runtime-retention';
import { createRuntimeRetentionTransform } from './runtime-retention-transform';
import {
  createRuntimeReadPorts,
  type RuntimeReadAttemptSignalBridge,
  type RuntimeReadCostResolver,
} from './runtime-read-ports';
import { parseRuntimeFinalMessage, type RuntimeFinalMessage } from './runtime-final-message';
import {
  createRuntimeTurnFactory,
  type RuntimeBeforeToolCallDelegate,
  type RuntimeTurnPortDependencies,
} from './runtime-turn-factory';
import type {
  RuntimeModelGuardAcceptance,
  RuntimeModelGuardCallOptions,
  RuntimeModelGuardModel,
} from './runtime-model-guard';
import type { RuntimeBudget } from './runtime-budget';
import type { RuntimePublicResponseDependencies } from './runtime-response';
import {
  createRuntimePhotoPreparationState,
  prepareAndMapRuntimeResponse,
  resetRuntimePhotoPreparationState,
} from './runtime-public-response';
import {
  currentBudget,
  observationResultIsReusable,
  observedWindow,
  RuntimeTurnCompositionError,
} from './runtime-turn-composition-support';
import { clearRuntimeCardSetId, registerRuntimeCardSetId } from '../thread-runtime/commit-port';

export type { RuntimePublicResponseDependencies } from './runtime-response';
export type RuntimeCompositionTurnRequest = RuntimeThinkTurnBuildRequest;

export type RuntimeCompositionModelContext = Omit<ModelContextSource, 'harness' | 'conditions'>;

export type RuntimeCompositionValidationContext =
  | SubmitValidationContext
  | ((input: {
      readonly now: string;
      readonly conditions: TurnConditionValues;
    }) => SubmitValidationContext);

export type RuntimeCompositionPersistMessages = RuntimeThinkPersistMessages;

type RuntimeTurnCompositionBaseOptions = {
  readonly request: RuntimeCompositionTurnRequest;
  readonly context: HarnessContext;
  readonly model: RuntimeModelGuardModel;
  readonly providerOptions?: TurnConfig['providerOptions'];
  readonly modelContext: RuntimeCompositionModelContext;
  readonly retention: RuntimeRetentionContext | (() => RuntimeRetentionContext);
  readonly budget: RuntimeBudget;
  readonly clock: ClockPort | (() => string);
  readonly ids: Pick<IdPort, 'nextCallId' | 'nextResponseId'>;
  readonly hashes: CommitHashPort;
  readonly registry: CandidateObservationRegistryPort;
  readonly ports: RuntimeTurnPortDependencies;
  /** Optional bridge shared with provider adapters so timeout abort reaches the actual fetch. */
  readonly attemptSignalBridge?: RuntimeReadAttemptSignalBridge;
  readonly commit: CommitPort;
  readonly resolveReadCost: RuntimeReadCostResolver;
  readonly validationContext: RuntimeCompositionValidationContext;
  readonly constraintContext: ConstraintValidationContext;
  readonly persistMessages: RuntimeCompositionPersistMessages;
  readonly isFinalResponse: (params: RuntimeModelGuardCallOptions) => boolean;
  readonly applyMetadata?: (metadata: ModelActionMetadata, conditions: TurnConditionValues) => void;
  readonly stopWhen?: Exclude<TurnConfig['stopWhen'], undefined>;
  readonly beforeToolCall?: RuntimeBeforeToolCallDelegate;
  readonly currentTurnStart?: number;
  readonly idempotencyKey?: string;
};

export type RuntimeTurnCompositionCoreOptions = RuntimeTurnCompositionBaseOptions & {
  readonly publicResponse?: undefined;
};

export type RuntimeTurnCompositionPublicOptions = RuntimeTurnCompositionBaseOptions & {
  readonly publicResponse: RuntimePublicResponseDependencies;
};

export type RuntimeTurnCompositionOptions =
  RuntimeTurnCompositionCoreOptions | RuntimeTurnCompositionPublicOptions;

export type RuntimeTurnComposition<Response = CommittedResponse> =
  RuntimeThinkComposition<Response> & {
    /** RuntimeThinkConnection passes this to its required configureSession option. */
    readonly configureSession: (session: Session) => Session;
  };

export { RuntimeTurnCompositionError } from './runtime-turn-composition-support';

const sameIdentity = (request: RuntimeCompositionTurnRequest, context: HarnessContext): boolean =>
  request.ownerScopeRef === context.ownerScopeRef &&
  request.threadId === context.threadId &&
  request.turnId === context.turnId &&
  request.revision === context.revision &&
  request.serverNow === context.serverNow;

const sameRetentionIdentity = (
  request: RuntimeCompositionTurnRequest,
  context: RuntimeRetentionContext,
): boolean =>
  request.ownerScopeRef === context.ownerScopeRef &&
  request.threadId === context.threadId &&
  request.turnId === context.turnId;

const clockFunction = (clock: ClockPort | (() => string)): (() => string) =>
  typeof clock === 'function' ? clock : () => clock.now();

const scopeIdentity = (context: RuntimeRetentionContext): RuntimeRetentionScopeIdentity => ({
  ownerScopeRef: context.ownerScopeRef,
  threadId: context.threadId,
  turnId: context.turnId,
});

const retentionContext = (
  value: RuntimeRetentionContext | (() => RuntimeRetentionContext),
): RuntimeRetentionContext => (typeof value === 'function' ? value() : value);

const narrowRepairs = (budget: RuntimeBudget): 0 | 1 | 2 => {
  const remaining = budget.snapshot().remainingRepairs;
  if (remaining === 0 || remaining === 1 || remaining === 2) return remaining;
  return 0;
};

const modelSource = (
  context: HarnessContext,
  source: RuntimeCompositionModelContext,
  conditions: TurnConditionValues,
  serverNow: string,
  budget: RuntimeBudget,
): ModelContextSource => ({
  harness: { ...context, serverNow, budget: currentBudget(budget) },
  userText: source.userText,
  history: source.history,
  cardSet: source.cardSet,
  conditions,
  evidence: source.evidence,
  ...(source.stationDirectory === undefined ? {} : { stationDirectory: source.stationDirectory }),
  ...(source.fieldPolicy === undefined ? {} : { fieldPolicy: source.fieldPolicy }),
});

const validationAt = (
  value: RuntimeCompositionValidationContext,
  now: string,
  conditions: TurnConditionValues,
): SubmitValidationContext => {
  if (typeof value === 'function') return value({ now, conditions });
  return {
    ...value,
    serverNow: now,
    departureAt: now,
    expectedObservationContext: {
      ...value.expectedObservationContext,
      homeStationRef: conditions.homeStationRef,
      minimumStayMinutes: conditions.minimumStayMinutes,
    },
    preferences: {
      ...value.preferences,
      maxWalkMinutes: conditions.maxWalkMinutes,
      homeStationRef: conditions.homeStationRef,
      minimumStayMinutes: conditions.minimumStayMinutes,
    },
  };
};

const configureCompaction = (session: Session): Session =>
  session.onCompaction((messages) => {
    const first = messages[0];
    const last = messages[messages.length - 1];
    if (first === undefined || last === undefined) return Promise.resolve(null);
    return Promise.resolve({
      fromMessageId: first.id,
      toMessageId: last.id,
      summary: sanitizeRuntimeCompactionSummary(undefined),
    });
  });

/**
 * Assembles one Think turn without owning the model loop. Every SDK-facing dependency is wired
 * here once: read calls pass through the budget adapter, submit calls create a Core application
 * port with the latest clock/conditions, and model history is rebuilt from Core projection.
 */
export function createRuntimeTurnComposition(
  options: RuntimeTurnCompositionPublicOptions,
): RuntimeTurnComposition<AssistantResponse>;
export function createRuntimeTurnComposition(
  options: RuntimeTurnCompositionCoreOptions,
): RuntimeTurnComposition<CommittedResponse>;
export function createRuntimeTurnComposition(
  options: RuntimeTurnCompositionOptions,
): RuntimeTurnComposition<CommittedResponse | AssistantResponse> {
  if (!sameIdentity(options.request, options.context)) {
    throw new RuntimeTurnCompositionError('CONTEXT_MISMATCH');
  }
  const initialRetention = retentionContext(options.retention);
  if (!sameRetentionIdentity(options.request, initialRetention)) {
    throw new RuntimeTurnCompositionError('RETENTION_MISMATCH');
  }

  const now = clockFunction(options.clock);
  const submitIdempotencyKey = options.idempotencyKey ?? `${options.context.turnId}-submit`;
  let disposed = false;
  const guardedCommit: CommitPort = {
    commit: (request) => {
      if (disposed) {
        return {
          status: 'conflict',
          conflict: {
            code: 'STALE_REVISION',
            message: 'turn composition was disposed',
          },
        };
      }
      return options.commit.commit(request);
    },
  };
  const application = new SubmitApplication(
    guardedCommit,
    { nextResponseId: options.ids.nextResponseId },
    options.hashes,
  );
  const calls = new Map<string, RuntimeRetentionEphemeralToolCall>();
  const results = new Map<string, RuntimeRetentionEphemeralToolResult>();
  let responseId: string | undefined;
  let responseRevision: number | undefined;
  let acceptedFinal: RuntimeFinalMessage | undefined;
  const photoPreparation = createRuntimePhotoPreparationState();
  const scope = (): RuntimeRetentionContext => {
    const current = retentionContext(options.retention);
    if (!sameRetentionIdentity(options.request, current)) {
      throw new RuntimeTurnCompositionError('RETENTION_MISMATCH');
    }
    return current;
  };

  const transform = createRuntimeRetentionTransform<ToolSet>({
    namespace: `runtime-${options.request.turnId}`,
    projectToolInput: (_toolName, input) => cloneRuntimeJsonValue(input),
    projectToolOutput: (_toolName, output) => {
      const current = scope();
      const window = observedWindow(output, current, options.registry);
      return { output: cloneRuntimeJsonValue(output), ...window };
    },
    onToolCall: (entry) => {
      const captured = captureRuntimeEphemeralToolCall(scope(), entry);
      calls.set(captured.toolCallId, captured);
    },
    onToolResult: (entry) => {
      const captured = captureRuntimeEphemeralToolResult(scope(), entry);
      results.set(captured.toolCallId, captured);
    },
  });

  const readPorts = createRuntimeReadPorts({
    budget: options.budget,
    resolveCost: options.resolveReadCost,
    ports: { search: options.ports.search, details: options.ports.details },
    ...(options.request.signal === undefined ? {} : { signal: options.request.signal }),
    ...(options.request.isStale === undefined ? {} : { isStale: options.request.isStale }),
    ...(options.attemptSignalBridge === undefined
      ? {}
      : { attemptSignalBridge: options.attemptSignalBridge }),
  });
  const baseValidation = (at: { now: string; conditions: TurnConditionValues }) =>
    validationAt(options.validationContext, at.now, at.conditions);
  const makeSubmitPort = (at: {
    readonly now: string;
    readonly conditions: TurnConditionValues;
  }): SubmitCardsPort => {
    const port = createSubmitCardsPort({
      application,
      registry: options.registry,
      scope: { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
      validationContext: baseValidation(at),
      expectedTurnId: options.context.turnId,
      expectedRevision: options.context.revision,
      idempotencyKey: options.idempotencyKey ?? `${options.context.turnId}-submit`,
      getRemainingRepairs: () => narrowRepairs(options.budget),
    });
    const cardSetId = options.publicResponse?.cardSetId;
    return {
      submit: async (input, execution, cancellation) => {
        if (cardSetId !== undefined) {
          registerRuntimeCardSetId(
            options.commit,
            { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
            submitIdempotencyKey,
            cardSetId,
          );
        }
        const result = await port.submit(input, execution, cancellation);
        if (result.status === 'committed') {
          responseId = result.responseId;
          responseRevision = result.revision;
        }
        return result;
      },
    };
  };
  const initialConditions: TurnConditionValues = {
    maxWalkMinutes: options.context.preferences.maxWalkMinutes,
    homeStationRef: options.context.preferences.homeStationRef,
    minimumStayMinutes: options.context.preferences.minimumStayMinutes,
  };
  const initialSubmit = makeSubmitPort({
    now: options.context.serverNow,
    conditions: initialConditions,
  });
  const turn = createRuntimeTurnFactory({
    context: options.context,
    budget: options.budget,
    ids: { nextCallId: options.ids.nextCallId },
    ports: {
      ...options.ports,
      clock: now,
      search: readPorts.search,
      details: readPorts.details,
      submit: initialSubmit,
    },
    buildSubmitPort: makeSubmitPort,
    constraintContext: options.constraintContext,
    applyMetadata: options.applyMetadata ?? (() => undefined),
    ...(options.request.signal === undefined ? {} : { signal: options.request.signal }),
    ...(options.request.isStale === undefined ? {} : { isStale: options.request.isStale }),
    ...(options.beforeToolCall === undefined ? {} : { beforeToolCall: options.beforeToolCall }),
    stopWhen: options.stopWhen ?? (() => options.budget.snapshot().completed),
    experimentalTransform: transform,
  });

  let currentTurnStart = options.currentTurnStart;
  const projectStep = (step: PrepareStepContext, _serverNow: string) => {
    const projectionNow = now();
    const currentRetention = scope();
    const conditions = turn.getConditions();
    const projected = projectModelContext(
      modelSource(turn.context, options.modelContext, conditions, projectionNow, options.budget),
    );
    currentTurnStart ??= Math.max(0, step.messages.length - options.request.messages.length);
    const expectedObservationContext = validationAt(
      options.validationContext,
      projectionNow,
      conditions,
    ).expectedObservationContext;
    const retentionProjection: RuntimeRetentionModelProjectionOptions = {
      currentTurnStart,
      currentScope: scopeIdentity(currentRetention),
      now: projectionNow,
      toolCalls: calls,
      toolResults: new Map(
        [...results].filter(([, entry]) =>
          observationResultIsReusable(
            entry.output,
            currentRetention,
            options.registry,
            expectedObservationContext,
          ),
        ),
      ),
    };
    const safeHistory = projectRuntimeCurrentTurnMessages(step.messages, retentionProjection);
    return {
      messages: [...encodeModelContext(projected), ...safeHistory],
      experimental_context: projected,
    };
  };

  const onAccepted = (acceptance: RuntimeModelGuardAcceptance): void => {
    if (acceptance.finalText === null || acceptance.terminal !== 'message') return;
    if (acceptedFinal !== undefined || responseId !== undefined) {
      throw new RuntimeTurnCompositionError('FINAL_COMMIT_INVALID');
    }
    acceptedFinal = parseRuntimeFinalMessage(acceptance.finalText, options.constraintContext);
    turn.applyMetadata(acceptedFinal.metadata);
  };

  return {
    model: options.model,
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    turn,
    retention: { context: options.retention, transform },
    projectStep,
    persistMessages: options.persistMessages,
    getCommittedResponse: async () => {
      if (disposed) {
        acceptedFinal = undefined;
        return undefined;
      }
      const final = acceptedFinal;
      if (final !== undefined) {
        acceptedFinal = undefined;
        const result = await application.commitMessage(
          final.message,
          validationAt(options.validationContext, now(), turn.getConditions()),
          options.registry,
          {
            scope: {
              ownerScopeRef: options.context.ownerScopeRef,
              threadId: options.context.threadId,
            },
            turnId: options.context.turnId,
            expectedRevision: options.context.revision,
            idempotencyKey: options.idempotencyKey ?? `${options.context.turnId}-final`,
          },
        );
        if (disposed) return undefined;
        if (result.status !== 'committed') {
          throw new RuntimeTurnCompositionError('FINAL_COMMIT_INVALID');
        }
        responseId = result.receipt.responseId;
        responseRevision = result.receipt.revision;
        options.budget.markCommitted();
      }
      if (responseId === undefined || responseRevision === undefined) return undefined;
      const committed = application.getCommittedResponse(
        { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
        options.context.turnId,
        responseId,
      );
      if (committed === undefined || options.publicResponse === undefined) return committed;
      return prepareAndMapRuntimeResponse({
        response: committed,
        dependencies: options.publicResponse,
        metadata: {
          threadId: options.context.threadId,
          turnId: options.context.turnId,
          responseId,
          revision: responseRevision,
        },
        now: now(),
        state: photoPreparation,
        isActive: () => !disposed,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      readPorts.dispose();
      clearRuntimeCardSetId(
        options.commit,
        { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
        submitIdempotencyKey,
      );
      calls.clear();
      results.clear();
      acceptedFinal = undefined;
      resetRuntimePhotoPreparationState(photoPreparation);
      application.clearTurn(
        { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
        options.context.turnId,
      );
    },
    isFinalResponse: options.isFinalResponse,
    onAccepted,
    configureSession: configureCompaction,
  };
}
