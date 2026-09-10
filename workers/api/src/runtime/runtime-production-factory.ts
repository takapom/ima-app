import type { Session, TurnConfig } from '@cloudflare/think';
import type { ThreadTurnRequest } from '@ima/contracts';
import type {
  CandidateObservationRegistryPort,
  CandidateRecord,
  CommitHashPort,
  CommitPort,
  DetailField,
  GetPlaceDetailsInput,
  HarnessContext,
  IdPort,
  PlaceDetailsPort,
  PlaceSearchPort,
  SubmitCardsPort,
  SubmitCardsPortResult,
  ToolExecutionContext,
  CancellationToken,
} from '@ima/core';
import { CandidateObservationRegistry } from '@ima/core';
import { normalizeGoogleOpeningHours } from '../providers/places/hours';
import { createPlacesDetailsAdapter } from '../providers/places-details/adapter';
import type { PlacesDetailsObservationPolicy } from '../providers/places-details/adapter-types';
import {
  isSupportedField,
  observationContextFor,
} from '../providers/places-details/adapter-support';
import { createGooglePlaceDetailsTransport } from '../providers/places-details/transport';
import { createPlacesSearchAdapter } from '../providers/places-search/adapter';
import type { PlacesSearchObservationPolicy } from '../providers/places-search/registration';
import { createPlacesSearchRegistration } from '../providers/places-search/registration';
import { createPlacesSearchContinuation } from '../providers/places-search/continuation';
import { createPlacesSearchCursorStore } from '../providers/places-search/cursor';
import { createGoogleTextSearchTransport } from '../providers/places-search/transport';
import { createLiveOpenAIProvider } from '../model/provider';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../model/provider-options';
import {
  createRuntimeReadAttemptSignalBridge,
  type RuntimeReadAttemptSignalBridge,
  type RuntimeReadCost,
  type RuntimeReadCostRequest,
} from './runtime-read-ports';
import {
  createRuntimeTurnComposition,
  type RuntimeTurnCompositionCoreOptions,
  type RuntimeCompositionModelContext,
  type RuntimeCompositionValidationContext,
  type RuntimePublicResponseDependencies,
} from './runtime-turn-composition';
import { RuntimeBudget } from './runtime-budget';
import {
  defaultProductionObservationPolicy,
  googlePlacesApiKey,
  harnessContextFor,
  placesCursorSecret,
  productionCapabilities,
  productionClock,
  productionClockPort,
  productionHash,
  productionMonotonicNow,
  productionPlacesEnabled,
  productionRetentionFor,
  productionSecret,
  ProductionIds,
  type ProductionRetentionSource,
  productionScopeFor,
  validationContextFor,
} from './runtime-production-support';
import {
  sanitizeRuntimeCompactionSummary,
  type RuntimeRetentionContext,
} from './runtime-retention';
import type {
  RuntimeThinkConnectionOptions,
  RuntimeThinkTurnBuildRequest,
} from './runtime-think-connection';
import type { RuntimeModelGuardCallOptions, RuntimeModelGuardModel } from './runtime-model-guard';

type ProductionBuildInput = {
  readonly request: RuntimeThinkTurnBuildRequest;
  readonly runtimeInput: ThreadTurnRequest;
  readonly context: HarnessContext;
  readonly attemptSignalBridge: RuntimeReadAttemptSignalBridge;
};

export type RuntimeProductionTurnPlan = {
  readonly model: RuntimeModelGuardModel;
  readonly providerOptions?: TurnConfig['providerOptions'];
  readonly registry: CandidateObservationRegistryPort;
  readonly search: PlaceSearchPort;
  readonly details: PlaceDetailsPort;
  readonly retention: RuntimeRetentionContext;
  readonly modelContext: RuntimeCompositionModelContext;
  readonly validationContext: RuntimeCompositionValidationContext;
  readonly ids: Pick<IdPort, 'nextCallId' | 'nextResponseId'>;
  readonly hashes: CommitHashPort;
  readonly publicResponse?: RuntimePublicResponseDependencies;
  /** Set true only for a host-owned final response step with read tools disabled. */
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
};

export type RuntimeProductionOverrides = {
  /** Test/host injection point; production leaves this unset. */
  readonly prepareTurn?: (input: ProductionBuildInput) => RuntimeProductionTurnPlan;
  readonly modelForTurn?: RuntimeModelGuardModel;
  readonly googlePlacesApiKey?: string;
  readonly placesCursorSecret?: string;
  readonly fetcher?: typeof fetch;
  readonly observationPolicy?: PlacesSearchObservationPolicy;
  readonly detailsObservationPolicy?: PlacesDetailsObservationPolicy;
  /** Explicit provider capability gate; retention policy is evaluated separately. */
  readonly placesEnabled?: boolean;
  /** Host-owned final response admission; the default plan keeps this false. */
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
  /** Explicitly permits current-turn model projection; omission stays deny-by-default. */
  readonly retention?: ProductionRetentionSource;
  readonly clock?: () => string;
  readonly monotonicNow?: () => number;
  readonly epochNow?: () => number;
};

export type RuntimeProductionConnectionOptions = {
  readonly env: unknown;
  readonly commit: CommitPort;
  readonly overrides?: RuntimeProductionOverrides;
};

const isConfiguredSecret = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

const unavailableSubmit = (): SubmitCardsPort => ({
  submit: (
    _input: Parameters<SubmitCardsPort['submit']>[0],
    _execution: ToolExecutionContext,
    _cancellation: CancellationToken,
  ): Promise<SubmitCardsPortResult> => {
    const result: SubmitCardsPortResult = {
      status: 'invalid',
      issues: [
        {
          code: 'MISSING_EVIDENCE',
          path: 'submit',
          message: 'submit adapter is not available before composition wiring',
          missingFields: [],
        },
      ],
      repairable: false,
      remainingRepairs: 0,
    };
    return Promise.resolve(result);
  },
});

const detailFieldFor = (field: string): DetailField | undefined => {
  switch (field) {
    case 'identity':
    case 'opening_hours':
    case 'price':
    case 'photos':
    case 'contact':
    case 'facilities':
    case 'walking_route':
    case 'last_train':
      return field;
    default:
      return undefined;
  }
};

const cardEvidenceResolver =
  (
    registry: CandidateObservationRegistryPort,
    context: HarnessContext,
  ): NonNullable<RuntimePublicResponseDependencies['resolveCardEvidence']> =>
  (candidateId, evidenceId) => {
    const observation = registry.readObservation(productionScopeFor(context), evidenceId);
    if (observation === undefined || observation.candidateId !== candidateId) return undefined;
    const field = detailFieldFor(observation.field);
    if (field === undefined) return undefined;
    return {
      observationId: observation.observationId,
      candidateId: observation.candidateId,
      field,
      sources: observation.sources,
      retention: observation.retention,
    };
  };

const areaLabelFor = (
  candidate: Readonly<CandidateRecord>,
  _context: HarnessContext,
  areaByCandidate: ReadonlyMap<string, string>,
): string => areaByCandidate.get(candidate.candidateId) ?? '検索結果の地域';

const buildModelContext = (input: ThreadTurnRequest): RuntimeCompositionModelContext => ({
  userText: input.text,
  history: [],
  cardSet: null,
  evidence: [],
});

const buildComposition = (
  options: RuntimeTurnCompositionCoreOptions,
  publicResponse: RuntimePublicResponseDependencies | undefined,
) =>
  publicResponse === undefined
    ? createRuntimeTurnComposition(options)
    : createRuntimeTurnComposition({ ...options, publicResponse });

const detailsProviderCost = (
  input: GetPlaceDetailsInput,
  context: HarnessContext,
  registry: CandidateObservationRegistryPort,
): number => {
  let requests = 0;
  const scope = productionScopeFor(context);
  const observationContext = observationContextFor(context);
  for (const request of input.requests) {
    let needsProvider = false;
    try {
      const candidate = registry.readCandidate(scope, request.candidateId);
      if (candidate === undefined || candidate.excluded || candidate.provider !== 'google_places') {
        continue;
      }
      for (const field of request.fields) {
        if (!isSupportedField(field)) continue;
        if (input.freshness === 'reuse_valid') {
          const reused = registry.evaluateObservationReuse({
            scope,
            candidateId: request.candidateId,
            field,
            context: observationContext,
          });
          if (reused.status === 'reusable') continue;
        }
        needsProvider = true;
        break;
      }
    } catch {
      // A registry failure must reserve conservatively; it must never undercharge an external read.
      needsProvider = true;
    }
    if (needsProvider) requests += 1;
  }
  return requests;
};

const resolveReadCost = (
  request: RuntimeReadCostRequest,
  registry: CandidateObservationRegistryPort,
): RuntimeReadCost => {
  const providerRequests =
    request.operation === 'search_places'
      ? 1
      : detailsProviderCost(request.input, request.context, registry);
  return {
    costUnits: providerRequests,
    providerHttpRequests: providerRequests,
    routeElements: 0,
  };
};

const defaultPlan = (
  input: ProductionBuildInput,
  env: unknown,
  clock: () => string,
  overrides: RuntimeProductionOverrides,
  ids: ProductionIds,
  registry: CandidateObservationRegistry,
  continuation: ReturnType<typeof createPlacesSearchContinuation>,
  areaByCandidate: Map<string, string>,
  turnRetention: ReturnType<typeof productionRetentionFor>,
): RuntimeProductionTurnPlan => {
  const apiKey = overrides.googlePlacesApiKey;
  const cursorSecret = overrides.placesCursorSecret;
  if (!isConfiguredSecret(apiKey) || !isConfiguredSecret(cursorSecret)) {
    throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');
  }
  const observationPolicy = overrides.observationPolicy;
  const policy = observationPolicy ?? defaultProductionObservationPolicy(clock);
  const detailsPolicy = overrides.detailsObservationPolicy ?? policy;
  const registration = createPlacesSearchRegistration({
    registry,
    clock: productionClockPort(clock),
    observationPolicy: policy,
  });
  const searchAdapter = createPlacesSearchAdapter({
    transport: createGoogleTextSearchTransport({
      apiKey,
      timeoutMs: 3_000,
      ...(overrides.fetcher === undefined ? {} : { fetcher: overrides.fetcher }),
    }),
    continuation,
    registration,
    nextSearchId: () => ids.nextSearchId(),
    clock,
    normalizeOpeningHours: normalizeGoogleOpeningHours,
    signalFor: input.attemptSignalBridge.signalFor,
  });
  const search: PlaceSearchPort = {
    search: async (searchInput, context, execution, cancellation) => {
      const result = await searchAdapter.search(searchInput, context, execution, cancellation);
      if (result.status === 'ok' || result.status === 'partial') {
        for (const candidate of result.data.candidates) {
          areaByCandidate.set(candidate.candidateId, result.data.applied.areaDescription);
        }
      }
      return result;
    },
  };
  const details = createPlacesDetailsAdapter({
    transport: createGooglePlaceDetailsTransport({
      apiKey,
      timeoutMs: 4_000,
      ...(overrides.fetcher === undefined ? {} : { fetcher: overrides.fetcher }),
    }),
    registry,
    clock: productionClockPort(clock),
    observationPolicy: detailsPolicy,
    areaLabelFor: (candidate, context) => areaLabelFor(candidate, context, areaByCandidate),
    signalFor: input.attemptSignalBridge.signalFor,
  });
  const retention: RuntimeRetentionContext = {
    ownerScopeRef: input.context.ownerScopeRef,
    threadId: input.context.threadId,
    turnId: input.context.turnId,
    retention: turnRetention,
  };
  const cardSetId = ids.nextCardSetId();
  return {
    model: overrides.modelForTurn ?? createLiveOpenAIProvider(env).model,
    providerOptions: OPENAI_PROVIDER_REQUEST_OPTIONS,
    ...(overrides.isFinalResponse === undefined
      ? {}
      : { isFinalResponse: overrides.isFinalResponse }),
    registry,
    search,
    details,
    retention,
    modelContext: buildModelContext(input.runtimeInput),
    validationContext: (at) => validationContextFor(input.context, at.now),
    ids,
    hashes: productionHash,
    publicResponse: {
      textRetention: turnRetention,
      cardSetId,
      resolveCardEvidence: cardEvidenceResolver(registry, input.context),
    },
  };
};

const makeOptions = (
  input: RuntimeProductionConnectionOptions,
  overrides: RuntimeProductionOverrides,
  ids: ProductionIds,
  registry: CandidateObservationRegistry,
  continuation: ReturnType<typeof createPlacesSearchContinuation> | undefined,
  clock: () => string,
  monotonicNow: () => number,
) => {
  const areaByCandidate = new Map<string, string>();
  const buildTurn = (request: RuntimeThinkTurnBuildRequest) => {
    const runtimeInput = request.runtimeInput;
    if (runtimeInput === undefined) throw new Error('RUNTIME_INPUT_MISSING');
    const turnRetention = productionRetentionFor(overrides.retention, request.serverNow);
    const placesEnabled = productionPlacesEnabled({
      prepareTurn: overrides.prepareTurn,
      ...(overrides.placesEnabled === undefined ? {} : { placesEnabled: overrides.placesEnabled }),
    });
    const context = harnessContextFor(request, runtimeInput, request.serverNow, {
      capabilities: productionCapabilities({
        placesEnabled,
      }),
    });
    const bridge = createRuntimeReadAttemptSignalBridge();
    const buildInput: ProductionBuildInput = {
      request,
      runtimeInput,
      context,
      attemptSignalBridge: bridge,
    };
    const prepared = overrides.prepareTurn?.(buildInput);
    const plan =
      prepared ??
      (continuation === undefined
        ? (() => {
            throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');
          })()
        : defaultPlan(
            buildInput,
            input.env,
            clock,
            overrides,
            ids,
            registry,
            continuation,
            areaByCandidate,
            turnRetention,
          ));
    const budget = new RuntimeBudget({
      startedAtMs: monotonicNow(),
      now: monotonicNow,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.isStale === undefined ? {} : { isStale: request.isStale }),
    });
    const base: RuntimeTurnCompositionCoreOptions = {
      request,
      context,
      model: plan.model,
      ...(plan.providerOptions === undefined ? {} : { providerOptions: plan.providerOptions }),
      modelContext: plan.modelContext,
      retention: plan.retention,
      budget,
      clock,
      ids: plan.ids,
      hashes: plan.hashes,
      registry: plan.registry,
      ports: {
        registry: plan.registry,
        clock,
        search: plan.search,
        details: plan.details,
        submit: unavailableSubmit(),
      },
      attemptSignalBridge: bridge,
      commit: input.commit,
      resolveReadCost: (read) => resolveReadCost(read, plan.registry),
      validationContext: plan.validationContext,
      constraintContext: { threadId: request.threadId, originalTurns: [] },
      persistMessages: () => Promise.resolve({ requestId: request.turnId, status: 'completed' }),
      isFinalResponse: plan.isFinalResponse ?? (() => false),
      stopWhen: () => budget.snapshot().completed,
      idempotencyKey: runtimeInput.idempotencyKey,
    };
    return buildComposition(base, plan.publicResponse);
  };
  return {
    clock,
    configureSession: (session: Session): Session =>
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
    buildTurn,
  } satisfies RuntimeThinkConnectionOptions<unknown>;
};

export const createRuntimeProductionConnectionOptions = (
  input: RuntimeProductionConnectionOptions,
): RuntimeThinkConnectionOptions<unknown> | undefined => {
  const overrides = input.overrides ?? {};
  const clock = overrides.clock ?? productionClock;
  const monotonicNow = overrides.monotonicNow ?? productionMonotonicNow;
  const apiKey = overrides.googlePlacesApiKey ?? googlePlacesApiKey(input.env);
  const cursorSecret = overrides.placesCursorSecret ?? placesCursorSecret(input.env);
  const modelReady =
    overrides.prepareTurn !== undefined ||
    overrides.modelForTurn !== undefined ||
    isConfiguredSecret(productionSecret(input.env, 'OPENAI_API_KEY'));
  const portsReady =
    overrides.prepareTurn !== undefined ||
    (isConfiguredSecret(apiKey) && isConfiguredSecret(cursorSecret));
  if (!modelReady || !portsReady) return undefined;
  const ids = new ProductionIds();
  const registry = new CandidateObservationRegistry(productionClockPort(clock), ids);
  if (
    overrides.prepareTurn === undefined &&
    (!isConfiguredSecret(apiKey) || !isConfiguredSecret(cursorSecret))
  ) {
    return undefined;
  }
  let continuation: ReturnType<typeof createPlacesSearchContinuation> | undefined;
  if (overrides.prepareTurn === undefined) {
    if (!isConfiguredSecret(cursorSecret)) return undefined;
    const epochNow = overrides.epochNow ?? Date.now;
    continuation = createPlacesSearchContinuation({
      store: createPlacesSearchCursorStore({ secret: cursorSecret, now: epochNow }),
      now: epochNow,
    });
  }
  const resolvedOverrides: RuntimeProductionOverrides = {
    ...overrides,
    ...(isConfiguredSecret(apiKey) ? { googlePlacesApiKey: apiKey } : {}),
    ...(isConfiguredSecret(cursorSecret) ? { placesCursorSecret: cursorSecret } : {}),
    ...(overrides.observationPolicy === undefined
      ? { observationPolicy: defaultProductionObservationPolicy(clock) }
      : {}),
  };
  return makeOptions(input, resolvedOverrides, ids, registry, continuation, clock, monotonicNow);
};
