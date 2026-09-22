import type { Session } from '@cloudflare/think';
import production from '@worker/entrypoints/cloudflare/worker';
import {
  RateLimitDO,
  ThreadDO as ProductionThreadDO,
} from '@worker/entrypoints/cloudflare/thread-do';
import { DEFAULT_RUNTIME_BUDGET, RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '@worker/adapters/out/providers/openai/provider-options';
import { sanitizeRuntimeCompactionSummary } from '@worker/runtime/retention/runtime-retention';
import {
  HotPepperError,
  type HotPepperSearchRequest,
} from '@worker/adapters/out/providers/hot-pepper/types';
import { createHotPepperTransport } from '@worker/adapters/out/providers/hot-pepper/transport';
import type { DurableCommitPort } from '@worker/adapters/out/persistence/thread/durable-commit-adapter';
import {
  createRuntimeTurnComposition,
  type RuntimePublicResponseDependencies,
} from '@worker/composition/runtime-turn-composition';
import type { RuntimeThinkConnectionOptions } from '@worker/runtime/turn-execution/runtime-think-connection';
import type { ValidatedEvidenceText } from '@worker/application/use-cases/submit-response/validation/submit-cards-evidence';
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

const HOT_PEPPER_REDIRECT_PROBE_REQUEST = {
  keyword: 'カフェ',
  count: 1,
} satisfies HotPepperSearchRequest;

const hotPepperRedirectProbe = async (): Promise<Response> => {
  let observedRedirect: RequestRedirect | null = null;
  const transport = createHotPepperTransport({
    apiKey: 'runtime-native-route-probe-key',
    fetcher: (input, init) => {
      observedRedirect = new Request(input, init).redirect;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://redirect.invalid' },
        }),
      );
    },
  });
  try {
    await transport.search(HOT_PEPPER_REDIRECT_PROBE_REQUEST);
    return Response.json({ code: 'UNEXPECTED_SUCCESS', redirect: observedRedirect, status: null });
  } catch (error: unknown) {
    if (!(error instanceof HotPepperError)) {
      return Response.json(
        { code: 'UNEXPECTED_ERROR', redirect: observedRedirect, status: null },
        { status: 500 },
      );
    }
    return Response.json({ code: error.code, redirect: observedRedirect, status: error.status });
  }
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

  /** Fixed test probe proving that console calls made inside this DO reach the test observer. */
  emitRuntimeNativeConsoleProbe(): void {
    const error = new Error('M24_CONSOLE_CONTROL');
    Object.defineProperty(error, 'cause', {
      value: { detail: 'M24_CONSOLE_CONTROL_CAUSE' },
      enumerable: false,
    });
    Object.defineProperty(error, 'hiddenDetail', {
      value: 'M24_CONSOLE_CONTROL_PROPERTY',
      enumerable: false,
    });
    console.warn(error, { M24_CONSOLE_CONTROL_KEY: true });
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
          rawProviderErrorDetailSeen: false,
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
          setConversationResponse: (record, response) =>
            durableCommit.setConversationResponse(record, response),
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
export { ProductionThreadDO } from './runtime-production-worker';
export { TelemetryDO } from '@worker/adapters/out/persistence/telemetry/telemetry-do';

type RuntimeNativeEnv = Parameters<typeof production.fetch>[1];
type RuntimeNativeExecutionContext = Parameters<typeof production.fetch>[2];

const runtimeNativeHandler = {
  async fetch(
    request: Request,
    env: RuntimeNativeEnv,
    executionContext: RuntimeNativeExecutionContext,
  ): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/__runtime-native/hot-pepper-redirect-probe') {
      return hotPepperRedirectProbe();
    }
    return production.fetch(request, env, executionContext);
  },
} satisfies typeof production;

export default runtimeNativeHandler;
