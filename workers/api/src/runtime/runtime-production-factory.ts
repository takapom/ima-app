import type { TurnConfig } from '@cloudflare/think';
import type { ThreadTurnRequest } from '@ima/contracts';
import type {
  CandidateObservationRegistryPort,
  CommitHashPort,
  CommitPort,
  ConstraintValidationContext,
  HarnessContext,
  IdPort,
  ModelContextFieldPolicy,
  PlaceDetailsPort,
  PlaceSearchPort,
} from '@ima/core';
import { CandidateObservationRegistry } from '@ima/core';
import { normalizeGoogleOpeningHours } from '../providers/places/hours';
import { createPlacesDetailsAdapter } from '../providers/places-details/adapter';
import type { PlacesDetailsObservationPolicy } from '../providers/places-details/adapter-types';
import { createGooglePlaceDetailsTransport } from '../providers/places-details/transport';
import { createPlacesSearchAdapter } from '../providers/places-search/adapter';
import type { PlacesSearchObservationPolicy } from '../providers/places-search/registration';
import { createPlacesSearchRegistration } from '../providers/places-search/registration';
import { createPlacesSearchContinuation } from '../providers/places-search/continuation';
import { createPlacesSearchCursorStore } from '../providers/places-search/cursor';
import { createGoogleTextSearchTransport } from '../providers/places-search/transport';
import type { JourneyServiceDateContextBuilder } from '../providers/last-train/port';
import type { LastTrainObservationPolicy } from '../providers/last-train/registration';
import type { PhotoTokenPreparerDependencies } from '../providers/photo/issuance';
import type { PhotoReferenceStoreResolver } from '../providers/photo/types';
import type { WalkingRouteObservationPolicy } from '../providers/routes/registration';
import type { RouteWaypointResolver } from '../providers/routes/resolver';
import { createLiveOpenAIProvider } from '../model/provider';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../model/provider-options';
import {
  createRuntimeReadAttemptSignalBridge,
  type RuntimeReadAttemptSignalBridge,
} from './runtime-read-ports';
import {
  createRuntimeTurnComposition,
  type RuntimeTurnCompositionCoreOptions,
  type RuntimeCompositionModelContext,
  type RuntimeCompositionValidationContext,
  type RuntimePublicResponseDependencies,
} from './runtime-turn-composition';
import {
  createRuntimeProductionContextStore,
  wrapRuntimeProductionCommit,
} from './runtime-production-context';
import { RuntimeBudget } from './runtime-budget';
import {
  defaultProductionObservationPolicy,
  capProductionObservationPolicy,
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
  sessionExpiryAt,
  type ProductionRetentionSource,
  productionScopeFor,
  validationContextFor,
} from './runtime-production-support';
import {
  createRuntimeLastTrainRevisionState,
  readActiveJourneyRevision,
  type RuntimeJourneyDataset,
  type RuntimeLastTrainCompositionOptions,
} from './runtime-provider-composition';
import {
  areaLabelFor,
  capabilitiesWithProviders,
  cardEvidenceResolver,
  createRuntimeProductionProviders,
  isConfiguredSecret,
  runtimeProductionProviderAvailabilityFor,
  type RuntimeProductionProviderAvailability,
} from './runtime-production-provider-config';
import { type RuntimeProductionProviderComposition } from './runtime-production-providers';
import { type RuntimeRetentionContext } from './runtime-retention';
import { configureRuntimeProductionSession } from './runtime-production-session';
import type {
  RuntimeThinkConnectionOptions,
  RuntimeThinkTurnBuildRequest,
} from './runtime-think-connection';
import type { RuntimeModelGuardCallOptions, RuntimeModelGuardModel } from './runtime-model-guard';
import { defaultRuntimeModelContextPolicy } from './runtime-field-policy';
import { unavailableSubmit } from './runtime-production-submit';
import { resolveRuntimeProductionReadCost } from './runtime-production-read-cost';
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
  readonly constraintContext: ConstraintValidationContext;
  readonly validationContext: RuntimeCompositionValidationContext;
  readonly ids: Pick<IdPort, 'nextCallId' | 'nextResponseId'>;
  readonly hashes: CommitHashPort;
  readonly publicResponse?: RuntimePublicResponseDependencies;
  readonly provider?: RuntimeProductionProviderComposition;
  readonly onCommitted?: (response: unknown) => void;
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
};
export type RuntimeProductionOverrides = {
  readonly prepareTurn?: (input: ProductionBuildInput) => RuntimeProductionTurnPlan;
  readonly modelForTurn?: RuntimeModelGuardModel;
  readonly googlePlacesApiKey?: string;
  readonly placesCursorSecret?: string;
  /** Dedicated Routes key; absence keeps route and last-train provider calls disabled. */
  readonly googleRoutesApiKey?: string;
  readonly fetcher?: typeof fetch;
  readonly observationPolicy?: PlacesSearchObservationPolicy;
  readonly routeObservationPolicy?: WalkingRouteObservationPolicy;
  readonly detailsObservationPolicy?: PlacesDetailsObservationPolicy;
  /** Explicit provider capability gate; retention policy is evaluated separately. */
  readonly placesEnabled?: boolean;
  /** Host-owned provider capability gate; no default allow is inferred from retention. */
  readonly routesEnabled?: boolean;
  readonly photosEnabled?: boolean;
  readonly photoTokenSecret?: string;
  readonly photoReferenceResolver?: PhotoReferenceStoreResolver;
  readonly photoDisplayPolicyFor?: PhotoTokenPreparerDependencies['displayPolicyFor'];
  readonly resolveStationWaypoint?: RouteWaypointResolver;
  readonly currentOriginRefFor?: (context: HarnessContext) => string | undefined;
  readonly journeyDataset?: RuntimeJourneyDataset;
  readonly buildServiceDateContext?: JourneyServiceDateContextBuilder;
  readonly lastTrainObservationPolicy?: LastTrainObservationPolicy;
  readonly fromStationRefFor?: RuntimeLastTrainCompositionOptions['fromStationRefFor'];
  readonly activeJourneyRevision?: number | null;
  /** Host-owned final response admission; the default plan keeps this false. */
  readonly isFinalResponse?: (params: RuntimeModelGuardCallOptions) => boolean;
  /** Host-evaluated retention snapshot; it does not grant model input access. */
  readonly retention?: ProductionRetentionSource;
  /** Host-evaluated llm_input snapshot; omission stays deny-by-default. */
  readonly modelContextFieldPolicy?: ModelContextFieldPolicy;
  /** Host-owned thread creation timestamp; its next 05:00 JST expiry is never extended. */
  readonly threadCreatedAt?: string;
  readonly clock?: () => string;
  readonly monotonicNow?: () => number;
  readonly epochNow?: () => number;
};
export type RuntimeProductionConnectionOptions = {
  readonly env: unknown;
  readonly commit: CommitPort;
  readonly overrides?: RuntimeProductionOverrides;
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
  contextStore: ReturnType<typeof createRuntimeProductionContextStore>,
  turnRetention: ReturnType<typeof productionRetentionFor>,
  fixedSessionExpiresAt: string,
  budget: RuntimeBudget,
  providerAvailability: RuntimeProductionProviderAvailability,
  lastTrainRevisionState: ReturnType<typeof createRuntimeLastTrainRevisionState>,
): RuntimeProductionTurnPlan => {
  const apiKey = overrides.googlePlacesApiKey;
  const cursorSecret = overrides.placesCursorSecret;
  if (!isConfiguredSecret(apiKey) || !isConfiguredSecret(cursorSecret)) {
    throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');
  }
  const observationPolicy = overrides.observationPolicy;
  const policy = capProductionObservationPolicy(
    observationPolicy ?? defaultProductionObservationPolicy(clock, fixedSessionExpiresAt),
    fixedSessionExpiresAt,
  );
  const detailsPolicy = capProductionObservationPolicy(
    overrides.detailsObservationPolicy ?? policy,
    fixedSessionExpiresAt,
  );
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
    ...(overrides.currentOriginRefFor === undefined
      ? {}
      : { originRefFor: overrides.currentOriginRefFor }),
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
    ...(overrides.currentOriginRefFor === undefined
      ? {}
      : { originRefFor: overrides.currentOriginRefFor }),
  });
  const retention: RuntimeRetentionContext = {
    ownerScopeRef: input.context.ownerScopeRef,
    threadId: input.context.threadId,
    turnId: input.context.turnId,
    retention: turnRetention,
  };
  const cardSetId = ids.nextCardSetId();
  const fieldPolicy = overrides.modelContextFieldPolicy ?? defaultRuntimeModelContextPolicy;
  const context = contextStore.beginTurn(
    input.runtimeInput,
    productionScopeFor(input.context),
    fieldPolicy,
  );
  const provider = createRuntimeProductionProviders({
    availability: providerAvailability,
    activeJourneyRevision: providerAvailability.activeJourneyRevision,
    baseDetails: details,
    registry,
    context: input.context,
    clock,
    budget,
    signalFor: input.attemptSignalBridge.signalFor,
    ...(input.request.signal === undefined ? {} : { requestSignal: input.request.signal }),
    ...(overrides.fetcher === undefined ? {} : { fetcher: overrides.fetcher }),
    ...(overrides.googleRoutesApiKey === undefined
      ? {}
      : { googleRoutesApiKey: overrides.googleRoutesApiKey }),
    ...(overrides.routeObservationPolicy === undefined
      ? {}
      : { routeObservationPolicy: overrides.routeObservationPolicy }),
    ...(overrides.resolveStationWaypoint === undefined
      ? {}
      : { resolveStationWaypoint: overrides.resolveStationWaypoint }),
    ...(overrides.currentOriginRefFor === undefined
      ? {}
      : { currentOriginRefFor: overrides.currentOriginRefFor }),
    ...(overrides.journeyDataset === undefined ? {} : { journeyDataset: overrides.journeyDataset }),
    ...(overrides.buildServiceDateContext === undefined
      ? {}
      : { buildServiceDateContext: overrides.buildServiceDateContext }),
    ...(overrides.lastTrainObservationPolicy === undefined
      ? {}
      : { lastTrainObservationPolicy: overrides.lastTrainObservationPolicy }),
    ...(overrides.fromStationRefFor === undefined
      ? {}
      : { fromStationRefFor: overrides.fromStationRefFor }),
    revisionState: lastTrainRevisionState,
    photoConfiguration: overrides,
    env,
    ...(input.request.deviceId === undefined ? {} : { deviceId: input.request.deviceId }),
  });
  return {
    model: overrides.modelForTurn ?? createLiveOpenAIProvider(env).model,
    providerOptions: OPENAI_PROVIDER_REQUEST_OPTIONS,
    ...(overrides.isFinalResponse === undefined
      ? {}
      : { isFinalResponse: overrides.isFinalResponse }),
    registry,
    search,
    details: provider.details,
    retention,
    modelContext: context.modelContext,
    validationContext: (at) =>
      validationContextFor(input.context, at.now, overrides.currentOriginRefFor?.(input.context)),
    ids,
    hashes: productionHash,
    publicResponse: {
      textRetention: turnRetention,
      cardSetId,
      resolveCardEvidence: cardEvidenceResolver(registry, input.context),
      ...(provider.preparePhotoTokens === undefined
        ? {}
        : { preparePhotoTokens: provider.preparePhotoTokens }),
    },
    provider,
    constraintContext: context.constraintContext,
    onCommitted: (response) => contextStore.commitTurn(input.runtimeInput, response),
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
  const contextStore = createRuntimeProductionContextStore({ registry });
  const lastTrainRevisionState = createRuntimeLastTrainRevisionState();
  let fixedSessionExpiresAt =
    overrides.threadCreatedAt === undefined
      ? undefined
      : sessionExpiryAt(overrides.threadCreatedAt);
  const buildTurn = async (request: RuntimeThinkTurnBuildRequest) => {
    const runtimeInput = request.runtimeInput;
    if (runtimeInput === undefined) throw new Error('RUNTIME_INPUT_MISSING');
    fixedSessionExpiresAt ??= sessionExpiryAt(request.serverNow);
    const turnRetention = productionRetentionFor(
      overrides.retention,
      request.serverNow,
      fixedSessionExpiresAt,
    );
    const placesEnabled = productionPlacesEnabled({
      prepareTurn: overrides.prepareTurn,
      ...(overrides.placesEnabled === undefined ? {} : { placesEnabled: overrides.placesEnabled }),
    });
    const activeJourneyRevision =
      overrides.activeJourneyRevision !== undefined
        ? overrides.activeJourneyRevision
        : overrides.journeyDataset === undefined
          ? undefined
          : await readActiveJourneyRevision(overrides.journeyDataset);
    const baseContext = harnessContextFor(request, runtimeInput, request.serverNow, {
      capabilities: productionCapabilities({ placesEnabled }),
    });
    const providerAvailability: RuntimeProductionProviderAvailability =
      runtimeProductionProviderAvailabilityFor({
        env: input.env,
        context: baseContext,
        placesEnabled,
        activeJourneyRevision,
        configuration: overrides,
        ...(request.deviceId === undefined ? {} : { deviceId: request.deviceId }),
      });
    const context = harnessContextFor(request, runtimeInput, request.serverNow, {
      capabilities: capabilitiesWithProviders(
        productionCapabilities({ placesEnabled }),
        providerAvailability,
      ),
    });
    const bridge = createRuntimeReadAttemptSignalBridge();
    const buildInput: ProductionBuildInput = {
      request,
      runtimeInput,
      context,
      attemptSignalBridge: bridge,
    };
    const prepared = overrides.prepareTurn?.(buildInput);
    const budget = new RuntimeBudget({
      startedAtMs: monotonicNow(),
      now: monotonicNow,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.isStale === undefined ? {} : { isStale: request.isStale }),
    });
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
            contextStore,
            turnRetention,
            fixedSessionExpiresAt,
            budget,
            providerAvailability,
            lastTrainRevisionState,
          ));
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
        ...(plan.modelContext.fieldPolicy === undefined
          ? {}
          : { modelContextFieldPolicy: plan.modelContext.fieldPolicy }),
      },
      attemptSignalBridge: bridge,
      commit: input.commit,
      resolveReadCost: (read) =>
        resolveRuntimeProductionReadCost(read, plan.registry, overrides.currentOriginRefFor),
      validationContext: plan.validationContext,
      constraintContext:
        prepared === undefined
          ? plan.constraintContext
          : { threadId: request.threadId, originalTurns: [] },
      persistMessages: () => Promise.resolve({ requestId: request.turnId, status: 'completed' }),
      isFinalResponse: plan.isFinalResponse ?? (() => false),
      stopWhen: () => budget.snapshot().completed,
      idempotencyKey: runtimeInput.idempotencyKey,
    };
    const composition =
      plan.publicResponse === undefined
        ? createRuntimeTurnComposition(base)
        : createRuntimeTurnComposition({ ...base, publicResponse: plan.publicResponse });
    return plan.onCommitted === undefined
      ? composition
      : wrapRuntimeProductionCommit(composition, plan.onCommitted);
  };
  return {
    clock,
    configureSession: configureRuntimeProductionSession,
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
  const routesApiKey =
    overrides.googleRoutesApiKey ?? productionSecret(input.env, 'GOOGLE_ROUTES_API_KEY');
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
    ...(isConfiguredSecret(routesApiKey) ? { googleRoutesApiKey: routesApiKey } : {}),
  };
  return makeOptions(input, resolvedOverrides, ids, registry, continuation, clock, monotonicNow);
};
