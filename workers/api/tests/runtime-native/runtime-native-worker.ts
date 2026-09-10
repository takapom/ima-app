import type { Session } from '@cloudflare/think';
import production from '../../src/index';
import { RateLimitDO, ThreadDO as ProductionThreadDO } from '../../src/thread-do';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '../../src/runtime/runtime-budget';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../../src/model/provider-options';
import { sanitizeRuntimeCompactionSummary } from '../../src/runtime/runtime-retention';
import type { DurableCommitPort } from '../../src/thread-runtime/commit-port';
import {
  createRuntimeTurnComposition,
  type RuntimePublicResponseDependencies,
} from '../../src/runtime/runtime-turn-composition';
import type { RuntimeThinkConnectionOptions } from '../../src/runtime/runtime-think-connection';
import type { ValidatedEvidenceText } from '@ima/core';
import {
  isRuntimeNativeScenario,
  createRuntimeNativeModel,
  type RuntimeNativeModelReport,
  type RuntimeNativeScenario,
} from './runtime-native-provider';
import {
  createRuntimeNativePortFixture,
  RUNTIME_NATIVE_NOW,
  type RuntimeNativePortFixture,
} from './runtime-native-ports';

export type RuntimeNativeExecutionReport = {
  readonly scenario: RuntimeNativeScenario;
  readonly model: RuntimeNativeModelReport;
  readonly operations: readonly string[];
  readonly commitWrites: number;
};

const textFromRuntimeInput = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('text' in value)) return '';
  return typeof value.text === 'string' ? value.text : '';
};

const scenarioFromText = (text: string): RuntimeNativeScenario => {
  const marker = /^\[runtime-native:([a-z-]+)\]/u.exec(text);
  const candidate = marker?.[1];
  return candidate !== undefined && isRuntimeNativeScenario(candidate)
    ? candidate
    : 'invalid-submit-details-valid';
};

type NativeEvidenceLink = ValidatedEvidenceText['evidence'][number];

const cardEvidenceResolver =
  (
    fixture: RuntimeNativePortFixture,
  ): NonNullable<RuntimePublicResponseDependencies['resolveCardEvidence']> =>
  (candidateId, evidenceId): NativeEvidenceLink | undefined => {
    const observation = fixture.registry.readObservation(fixture.scope, evidenceId);
    if (observation === undefined || observation.candidateId !== candidateId) return undefined;
    if (observation.field !== 'identity' && observation.field !== 'opening_hours') {
      return undefined;
    }
    return {
      observationId: observation.observationId,
      candidateId: observation.candidateId,
      field: observation.field,
      sources: observation.sources,
      retention: observation.retention,
    };
  };

export class ThreadDO extends ProductionThreadDO {
  override maxSteps = DEFAULT_RUNTIME_BUDGET.maxModelSteps;
  private latestExecution: {
    readonly scenario: RuntimeNativeScenario;
    readonly model: RuntimeNativeModelReport;
    readonly fixture: RuntimeNativePortFixture;
    commitWrites: number;
  } | null = null;

  getRuntimeNativeReport(): RuntimeNativeExecutionReport | null {
    const current = this.latestExecution;
    if (current === null) return null;
    return structuredClone({
      scenario: current.scenario,
      model: current.model,
      operations: current.fixture.operations,
      commitWrites: current.commitWrites,
    });
  }

  protected override createRuntimeThinkConnectionOptions(): RuntimeThinkConnectionOptions<unknown> {
    let configureSession: ((session: Session) => Session) | undefined;
    return {
      clock: () => RUNTIME_NATIVE_NOW,
      configureSession: (session) =>
        configureSession?.(session) ??
        session.onCompaction((messages) => {
          const first = messages[0];
          const last = messages[messages.length - 1];
          if (first === undefined || last === undefined) return Promise.resolve(null);
          return Promise.resolve({
            fromMessageId: first.id,
            toMessageId: last.id,
            summary: sanitizeRuntimeCompactionSummary(undefined),
          });
        }),
      buildTurn: (request) => {
        const runtimeInput = 'runtimeInput' in request ? request.runtimeInput : undefined;
        const inputText = textFromRuntimeInput(runtimeInput);
        const scenario = scenarioFromText(inputText);
        const fixture = createRuntimeNativePortFixture({
          ownerScopeRef: request.ownerScopeRef,
          threadId: request.threadId,
          turnId: request.turnId,
          revision: request.revision,
          serverNow: request.serverNow,
        });
        const modelReport: RuntimeNativeModelReport = {
          calls: 0,
          requests: [],
          providerOptionsSeen: [],
          waitingStarted: false,
          abortObserved: false,
        };
        const execution = {
          scenario,
          model: modelReport,
          fixture,
          commitWrites: 0,
        };
        this.latestExecution = execution;
        const durableCommit = this.createRuntimeCommitPort();
        const commit: DurableCommitPort = {
          setCardSetId: (scope, idempotencyKey, cardSetId) =>
            durableCommit.setCardSetId(scope, idempotencyKey, cardSetId),
          clearCardSetId: (scope, idempotencyKey) =>
            durableCommit.clearCardSetId(scope, idempotencyKey),
          commit: async (value) => {
            const result = await durableCommit.commit(value);
            if (result.status === 'committed' && !result.receipt.replayed) {
              execution.commitWrites += 1;
            }
            return result;
          },
        };
        const startedAtMs = performance.now();
        const budget = new RuntimeBudget({
          config: DEFAULT_RUNTIME_BUDGET,
          startedAtMs,
          now: () => performance.now(),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(request.isStale === undefined ? {} : { isStale: request.isStale }),
        });
        const composition = createRuntimeTurnComposition({
          request,
          context: fixture.context,
          model: createRuntimeNativeModel(scenario, fixture.inputs, modelReport),
          providerOptions: OPENAI_PROVIDER_REQUEST_OPTIONS,
          modelContext: {
            userText: inputText,
            history: [],
            cardSet: null,
            evidence: [],
          },
          retention: fixture.retention,
          budget,
          clock: () => fixture.context.serverNow,
          ids: {
            nextCallId: () => `runtime-native-call-${modelReport.calls + 1}`,
            nextResponseId: () => `runtime-native-response-${modelReport.calls + 1}`,
          },
          hashes: fixture.hashes,
          registry: fixture.registry,
          ports: {
            registry: fixture.registry,
            ...fixture.ports,
            clock: () => fixture.context.serverNow,
          },
          commit,
          resolveReadCost: () => ({
            costUnits: 1,
            providerHttpRequests: 1,
            routeElements: 0,
          }),
          validationContext: ({ now }) => ({
            ...fixture.validationContext,
            serverNow: now,
            departureAt: now,
          }),
          constraintContext: { threadId: request.threadId, originalTurns: [] },
          persistMessages: () =>
            Promise.resolve({ requestId: 'runtime-native-placeholder', status: 'completed' }),
          isFinalResponse: () => true,
          stopWhen: () => execution.commitWrites > 0,
          publicResponse: {
            textRetention: fixture.retention.retention,
            cardSetId: 'runtime-native-card-set',
            resolveCardEvidence: cardEvidenceResolver(fixture),
          },
        });
        configureSession = composition.configureSession;
        return composition;
      },
    };
  }
}

export { RateLimitDO };
export default production;
