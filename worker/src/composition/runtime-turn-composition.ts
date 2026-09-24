import { createPublicToolSet } from '@worker/adapters/in/tools';
import type { PrepareStepContext, Session, TurnConfig } from '@cloudflare/think';
import type { JSONValue, ToolSet } from 'ai';
import type { AssistantResponse } from '@ima/contracts';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { ClockPort, HarnessContext, IdPort } from '@worker/application/ports/context';
import type { CommitHashPort, CommitPort } from '@worker/application/ports/commit';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import type { ModelContextSource } from '@worker/application/model-context/model-context';
import type { RespondPort } from '@worker/application/ports/submission';
import type { SubmitValidationContext } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
import { projectModelContext } from '@worker/application/model-context/model-context';
import { SubmitApplication } from '@worker/application/use-cases/submit-response/submit-application';
import { createRespondPort } from '@worker/application/use-cases/submit-response/respond-port';
import { encodeModelContext } from '@worker/runtime/model/encoding';
import type {
  RuntimeThinkComposition,
  RuntimeThinkPersistMessages,
  RuntimeThinkTurnBuildRequest,
} from '@worker/runtime/turn-execution/runtime-think-connection';
import {
  projectRuntimeCurrentTurnMessages,
  type RuntimeRetentionModelProjectionOptions,
} from '@worker/runtime/retention/runtime-retention-model';
import {
  captureRuntimeEphemeralToolCall,
  captureRuntimeEphemeralToolResult,
  cloneRuntimeJsonValue,
  type RuntimeRetentionContext,
  type RuntimeRetentionEphemeralToolCall,
  type RuntimeRetentionEphemeralToolResult,
  type RuntimeRetentionScopeIdentity,
} from '@worker/runtime/retention/runtime-retention';
import { createRuntimeRetentionTransform } from '@worker/runtime/retention/runtime-retention-transform';
import {
  createRuntimeReadPorts,
  type RuntimeReadAttemptSignalBridge,
  type RuntimeReadCostResolver,
} from '@worker/runtime/tool-reads/runtime-read-ports';
import {
  createRuntimeTurnFactory,
  type RuntimeBeforeToolCallDelegate,
  type RuntimeTurnPortDependencies,
} from '@worker/runtime/turn-execution/runtime-turn-factory';
import { createRuntimeFinalResponseHooks } from '@worker/runtime/turn-execution/runtime-final-response';
import type {
  RuntimeModelGuardAcceptance,
  RuntimeModelGuardCallOptions,
  RuntimeModelGuardModel,
} from '@worker/runtime/turn-execution/runtime-model-guard';
import type { RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import type { RuntimePublicResponseDependencies } from '@worker/runtime/response/runtime-response';
import {
  createRuntimePhotoPreparationState,
  prepareAndMapRuntimeResponse,
  resetRuntimePhotoPreparationState,
} from '@worker/runtime/response/runtime-public-response';
import {
  modelSource,
  observationResultIsReusable,
  observationIdsIn,
  observedWindow,
  RuntimeTurnCompositionError,
  prepareConversationCommit,
} from '@worker/composition/runtime-turn-composition-support';
import { observeRuntimeTerminalFormatFailure } from '@worker/runtime/turn-execution/runtime-submit-diagnostic';
import {
  clearRuntimeCardSetId,
  registerRuntimeCardSetId,
} from '@worker/adapters/out/persistence/thread/durable-commit-adapter';
import { projectRuntimeToolResultForModel } from '@worker/runtime/context/runtime-field-policy';
import { configureRuntimeCompaction } from '@worker/runtime/retention/runtime-session-config';
import { createRuntimePresentedInputs } from '@worker/runtime/response/runtime-presented-inputs';
import { recordPresentedContext } from '@worker/composition/runtime-presented-context';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import {
  runtimeTurnObserverWriters,
  type RuntimeTurnObserver,
} from '@worker/runtime/turn-execution/runtime-submit-diagnostic';

export type { RuntimePublicResponseDependencies } from '@worker/runtime/response/runtime-response';
export type RuntimeCompositionTurnRequest = RuntimeThinkTurnBuildRequest;

export type RuntimeCompositionModelContext = Omit<ModelContextSource, 'harness'>;

export type RuntimeCompositionValidationContext =
  SubmitValidationContext | ((input: { readonly now: string }) => SubmitValidationContext);

export type RuntimeCompositionPersistMessages = RuntimeThinkPersistMessages;

type RuntimeTurnCompositionBaseOptions = {
  readonly request: RuntimeCompositionTurnRequest;
  readonly context: HarnessContext;
  readonly model: RuntimeModelGuardModel;
  readonly providerOptions?: TurnConfig['providerOptions'];
  readonly modelContext: RuntimeCompositionModelContext;
  /** Retention of the history bodies in `modelContext`; generated text inherits it. */
  readonly historyRetention?: readonly RetentionMetadata[];
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
  readonly persistMessages: RuntimeCompositionPersistMessages;
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
  readonly stopWhen?: Exclude<TurnConfig['stopWhen'], undefined>;
  readonly beforeToolCall?: RuntimeBeforeToolCallDelegate;
  readonly currentTurnStart?: number;
  readonly idempotencyKey?: string;
  readonly turnObserver?: RuntimeTurnObserver;
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

export { RuntimeTurnCompositionError } from '@worker/composition/runtime-turn-composition-support';

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

const validationAt = (
  value: RuntimeCompositionValidationContext,
  now: string,
): SubmitValidationContext =>
  typeof value === 'function' ? value({ now }) : { ...value, serverNow: now };

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
  const presented = createRuntimePresentedInputs({
    registry: options.registry,
    scope: { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
  });
  // Generated text is bounded by everything shown to the model this turn, not by what it cites.
  const publicResponse = (): RuntimePublicResponseDependencies | undefined =>
    options.publicResponse === undefined
      ? undefined
      : {
          ...options.publicResponse,
          textRetention: presented.textRetention(options.publicResponse.textRetention),
        };
  const application = new SubmitApplication(
    guardedCommit,
    { nextResponseId: options.ids.nextResponseId },
    options.hashes,
    (record, response) =>
      prepareConversationCommit(options.commit, publicResponse(), record, response),
  );
  const calls = new Map<string, RuntimeRetentionEphemeralToolCall>();
  const results = new Map<string, RuntimeRetentionEphemeralToolResult>();
  let responseId: string | undefined;
  let responseRevision: number | undefined;
  const photoPreparation = createRuntimePhotoPreparationState();
  const scope = (): RuntimeRetentionContext => {
    const current = retentionContext(options.retention);
    if (!sameRetentionIdentity(options.request, current)) {
      throw new RuntimeTurnCompositionError('RETENTION_MISMATCH');
    }
    return current;
  };

  const transform = createRuntimeRetentionTransform<ToolSet>({
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
  const makeRespondPort = (at: { readonly now: string }): RespondPort => {
    const port = createRespondPort({
      application,
      registry: options.registry,
      scope: { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
      validationContext: validationAt(options.validationContext, at.now),
      expectedTurnId: options.context.turnId,
      expectedRevision: options.context.revision,
      idempotencyKey: options.idempotencyKey ?? `${options.context.turnId}-submit`,
      getRemainingRepairs: () => narrowRepairs(options.budget),
    });
    const cardSetId = options.publicResponse?.cardSetId;
    return {
      respond: async (input, execution, cancellation) => {
        if (input.kind === 'propose' && cardSetId !== undefined) {
          registerRuntimeCardSetId(
            options.commit,
            { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
            submitIdempotencyKey,
            cardSetId,
          );
        }
        const result = await port.respond(input, execution, cancellation);
        if (result.status === 'committed') {
          responseId = result.responseId;
          responseRevision = result.revision;
        }
        return result;
      },
    };
  };
  const finalResponse = createRuntimeFinalResponseHooks({
    budget: options.budget,
    ...(options.isFinalResponse === undefined ? {} : { isFinalResponse: options.isFinalResponse }),
    ...(options.beforeToolCall === undefined ? {} : { beforeToolCall: options.beforeToolCall }),
  });
  const turn = createRuntimeTurnFactory({
    createTools: createPublicToolSet,
    context: options.context,
    budget: options.budget,
    ids: { nextCallId: options.ids.nextCallId },
    ports: {
      ...options.ports,
      clock: now,
      search: readPorts.search,
      details: readPorts.details,
      readAdmission: readPorts.admission,
      respond: makeRespondPort({ now: options.context.serverNow }),
    },
    buildRespondPort: makeRespondPort,
    ...(options.request.signal === undefined ? {} : { signal: options.request.signal }),
    ...(options.request.isStale === undefined ? {} : { isStale: options.request.isStale }),
    beforeStep: finalResponse.beforeStep,
    beforeToolCall: finalResponse.beforeToolCall,
    stopWhen: options.stopWhen ?? (() => options.budget.snapshot().completed),
    experimentalTransform: transform,
    ...(options.turnObserver === undefined ? {} : runtimeTurnObserverWriters(options.turnObserver)),
  });

  let currentTurnStart = options.currentTurnStart;
  const projectStep = (step: PrepareStepContext, _serverNow: string) => {
    const projectionNow = now();
    const currentRetention = scope();
    const projected = projectModelContext(
      modelSource(turn.context, options.modelContext, projectionNow, options.budget),
    );
    recordPresentedContext(
      presented,
      projected,
      options.modelContext,
      options.historyRetention ?? [],
    );
    currentTurnStart ??= Math.max(0, step.messages.length - options.request.messages.length);
    const expectedObservationContext = validationAt(
      options.validationContext,
      projectionNow,
    ).expectedObservationContext;
    const fieldPolicy = options.modelContext.fieldPolicy;
    const projectToolOutput =
      fieldPolicy === undefined
        ? undefined
        : (output: JSONValue) =>
            projectRuntimeToolResultForModel(output, fieldPolicy, presented.observation);
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
      ...(projectToolOutput === undefined ? {} : { projectToolOutput }),
    };
    // Without a field policy the model receives tool outputs whole.
    if (fieldPolicy === undefined) {
      for (const entry of retentionProjection.toolResults.values()) {
        for (const observationId of observationIdsIn(entry.output)) {
          presented.observation(observationId);
        }
      }
    }
    const safeHistory = projectRuntimeCurrentTurnMessages(step.messages, retentionProjection);
    return {
      messages: [...encodeModelContext(projected), ...safeHistory],
      experimental_context: projected,
    };
  };

  const onAccepted = (acceptance: RuntimeModelGuardAcceptance): void => {
    // A step without respond commits nothing; the reason is the only record of it.
    if (acceptance.missingRespond !== null) {
      observeRuntimeTerminalFormatFailure(acceptance.missingRespond);
    }
  };

  return {
    model: options.model,
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    turn,
    // Stored SDK messages carry the generated text, so they take the same bound as its response.
    retention: {
      context: () => {
        const current = retentionContext(options.retention);
        return { ...current, retention: presented.textRetention(current.retention) };
      },
      transform,
    },
    projectStep,
    persistMessages: options.persistMessages,
    getCommittedResponse: async () => {
      if (disposed) return undefined;
      if (responseId === undefined || responseRevision === undefined) return undefined;
      const committed = application.getCommittedResponse(
        { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
        options.context.turnId,
        responseId,
      );
      const dependencies = publicResponse();
      if (committed === undefined || dependencies === undefined) return committed;
      return prepareAndMapRuntimeResponse({
        response: committed,
        dependencies,
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
      resetRuntimePhotoPreparationState(photoPreparation);
      application.clearTurn(
        { ownerScopeRef: options.context.ownerScopeRef, threadId: options.context.threadId },
        options.context.turnId,
      );
    },
    isFinalResponse: finalResponse.isFinalResponse,
    reserveModelStep: finalResponse.reserveModelStep,
    onAccepted,
    configureSession: configureRuntimeCompaction,
  };
}
