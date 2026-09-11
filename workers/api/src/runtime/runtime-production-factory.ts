import { CandidateObservationRegistry } from '@ima/core';
import type { createPlacesSearchContinuation } from '../providers/places-search/continuation';
import { createLiveOpenAIProvider } from '../model/provider';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '../model/provider-options';
import { createRuntimeReadAttemptSignalBridge } from './runtime-read-ports';
import { wrapRuntimeModelTrace } from './runtime-model-trace';
import { createRuntimeProviderTransportObserver } from '../providers/telemetry/runtime-provider-trace';
import {
  createRuntimeTurnComposition,
  type RuntimeTurnCompositionCoreOptions,
} from './runtime-turn-composition';
import { wrapRuntimeProductionCommit } from './runtime-production-context';
import { createFactoryRuntimeContext } from './runtime-production-context-factory';
import { RuntimeBudget } from './runtime-budget';
import {
  harnessContextFor,
  productionCapabilities,
  productionClock,
  productionClockPort,
  productionHash,
  productionMonotonicNow,
  productionPlacesEnabled,
  productionRetentionFor,
  ProductionIds,
  productionScopeFor,
  validationContextFor,
} from './runtime-production-support';
import {
  createRuntimeLastTrainRevisionState,
  readActiveJourneyRevision,
} from './runtime-provider-composition';
import {
  capabilitiesWithProviders,
  cardEvidenceResolver,
  createRuntimeProductionProviders,
  hotPepperRuntimeModeFor,
  runtimeProductionProviderAvailabilityFor,
  type RuntimeProductionProviderAvailability,
} from './runtime-production-provider-config';
import { configureRuntimeProductionSession } from './runtime-production-session';
import type {
  RuntimeThinkConnectionOptions,
  RuntimeThinkTurnBuildRequest,
} from './runtime-think-connection';
import { defaultRuntimeModelContextPolicy } from './runtime-field-policy';
import { unavailableSubmit } from './runtime-production-submit';
import { resolveRuntimeProductionReadCost } from './runtime-production-read-cost';
import { createRuntimeProductionPlacePorts } from './runtime-production-place-ports';
import { createFactoryContinuation } from './runtime-production-continuation';
import { resolveRuntimeOperationalAdmission } from './runtime-operational-admission';
import {
  devFixtureEnvironmentFor,
  devFixtureOverridesFor,
  isKeylessDevFixtureEnvironment,
} from './runtime-dev-fixture';
import type { RuntimeRetentionContext } from './runtime-retention';
import type {
  ProductionBuildInput,
  RuntimeProductionConnectionOptions,
  RuntimeProductionOverrides,
  RuntimeProductionTurnPlan,
} from './runtime-production-types';

export type {
  ProductionBuildInput,
  RuntimeProductionConnectionOptions,
  RuntimeProductionOverrides,
  RuntimeProductionTurnPlan,
} from './runtime-production-types';
const defaultPlan = (
  input: ProductionBuildInput,
  env: unknown,
  clock: () => string,
  monotonicNow: () => number,
  overrides: RuntimeProductionOverrides,
  ids: ProductionIds,
  registry: CandidateObservationRegistry,
  continuation: ReturnType<typeof createPlacesSearchContinuation> | undefined,
  areaByCandidate: Map<string, string>,
  contextStore: ReturnType<typeof createFactoryRuntimeContext>['contextStore'],
  turnRetention: ReturnType<typeof productionRetentionFor>,
  fixedSessionExpiresAt: string,
  budget: RuntimeBudget,
  providerAvailability: RuntimeProductionProviderAvailability,
  lastTrainRevisionState: ReturnType<typeof createRuntimeLastTrainRevisionState>,
): RuntimeProductionTurnPlan => {
  const providerTraceObserver =
    overrides.providerTraceSink === undefined
      ? undefined
      : createRuntimeProviderTransportObserver({
          ownerScopeRef: input.request.ownerScopeRef,
          threadId: input.request.threadId,
          turnId: input.request.turnId,
          revision: input.request.revision,
          clock,
          monotonicNow,
          sink: overrides.providerTraceSink,
        });
  const places = createRuntimeProductionPlacePorts({
    build: input,
    env,
    clock,
    overrides,
    ids,
    registry,
    continuation,
    areaByCandidate,
    fixedSessionExpiresAt,
    budget,
    providerAvailability,
    ...(providerTraceObserver === undefined ? {} : { providerTraceObserver }),
  });
  const { search, details } = places;
  const savedReference = places.savedReference;
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
    ...(providerTraceObserver === undefined ? {} : { providerTraceObserver }),
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
  const modelFromConfiguredProvider = overrides.modelForTurn === undefined;
  const cardEvidence = cardEvidenceResolver(
    registry,
    input.context,
    providerAvailability.hotPepperEnabled && overrides.hotPepperFieldPolicy !== undefined
      ? {
          hotPepperFieldPolicy: overrides.hotPepperFieldPolicy,
          hotPepperMode: hotPepperRuntimeModeFor(env) ?? 'live',
        }
      : {},
  );
  return {
    model: overrides.modelForTurn ?? createLiveOpenAIProvider(env).model,
    ...(modelFromConfiguredProvider ? { modelTraceProvider: 'openai' as const } : {}),
    providerOptions: OPENAI_PROVIDER_REQUEST_OPTIONS,
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
      resolveCardEvidence: cardEvidence,
      ...(provider.preparePhotoTokens === undefined
        ? {}
        : { preparePhotoTokens: provider.preparePhotoTokens }),
    },
    provider,
    ...(savedReference === undefined
      ? {}
      : {
          savedPlaceReferenceResolver: savedReference.resolver,
          savedReferenceHandoff: savedReference.handoff,
        }),
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
  const lastTrainRevisionState = createRuntimeLastTrainRevisionState();
  const contextSetup = createFactoryRuntimeContext({
    registry,
    ...(overrides.threadCreatedAt === undefined
      ? {}
      : { threadCreatedAt: overrides.threadCreatedAt }),
    ...(overrides.contextPersistence === undefined
      ? {}
      : { persistence: overrides.contextPersistence }),
    clock,
  });
  const buildTurn = async (request: RuntimeThinkTurnBuildRequest) => {
    const runtimeInput = request.runtimeInput;
    if (runtimeInput === undefined) throw new Error('RUNTIME_INPUT_MISSING');
    const fixedSessionExpiresAt = contextSetup.ensureSessionExpiry(request.serverNow);
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
        : overrides.lastTrainEnabled === false || overrides.journeyDataset === undefined
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
      (continuation === undefined && providerAvailability.placesEnabled
        ? (() => {
            throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');
          })()
        : defaultPlan(
            buildInput,
            input.env,
            clock,
            monotonicNow,
            overrides,
            ids,
            registry,
            continuation,
            areaByCandidate,
            contextSetup.contextStore,
            turnRetention,
            fixedSessionExpiresAt,
            budget,
            providerAvailability,
            lastTrainRevisionState,
          ));
    const model =
      overrides.modelTraceSink === undefined
        ? plan.model
        : wrapRuntimeModelTrace(plan.model, {
            ownerScopeRef: request.ownerScopeRef,
            threadId: request.threadId,
            turnId: request.turnId,
            revision: request.revision,
            ...(plan.modelTraceProvider === undefined ? {} : { provider: plan.modelTraceProvider }),
            clock,
            monotonicNow,
            sink: overrides.modelTraceSink,
          });
    const base: RuntimeTurnCompositionCoreOptions = {
      request,
      context,
      model,
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
        ...(plan.savedPlaceReferenceResolver === undefined
          ? {}
          : { savedPlaceReferenceResolver: plan.savedPlaceReferenceResolver }),
        ...(plan.savedReferenceHandoff === undefined
          ? {}
          : { onTurnDispose: plan.savedReferenceHandoff.clear }),
        ...(plan.modelContext.fieldPolicy === undefined
          ? {}
          : { modelContextFieldPolicy: plan.modelContext.fieldPolicy }),
      },
      attemptSignalBridge: bridge,
      commit: input.commit,
      resolveReadCost: (read) =>
        resolveRuntimeProductionReadCost(
          read,
          plan.registry,
          overrides.currentOriginRefFor,
          plan.savedReferenceHandoff,
        ),
      validationContext: plan.validationContext,
      constraintContext:
        prepared === undefined
          ? plan.constraintContext
          : { threadId: request.threadId, originalTurns: [] },
      persistMessages: () => Promise.resolve({ requestId: request.turnId, status: 'completed' }),
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
  const devFixture = isKeylessDevFixtureEnvironment(input.env);
  const effectiveEnv = devFixture ? devFixtureEnvironmentFor(input.env) : input.env;
  const configuredOverrides = input.overrides ?? {};
  const overrides = devFixture ? devFixtureOverridesFor(configuredOverrides) : configuredOverrides;
  const clock = overrides.clock ?? productionClock;
  const monotonicNow = overrides.monotonicNow ?? productionMonotonicNow;
  const admission = resolveRuntimeOperationalAdmission({
    env: effectiveEnv,
    hasPrepareTurn: overrides.prepareTurn !== undefined,
    hasModelOverride: overrides.prepareTurn !== undefined || overrides.modelForTurn !== undefined,
    hasFetcher: overrides.fetcher !== undefined,
    placesRequested: productionPlacesEnabled({
      prepareTurn: overrides.prepareTurn,
      placesEnabled: overrides.placesEnabled ?? true,
    }),
    routesRequested: overrides.routesEnabled === true,
    photosRequested: overrides.photosEnabled === true,
    ...(overrides.googlePlacesApiKey === undefined
      ? {}
      : { googlePlacesApiKeyOverride: overrides.googlePlacesApiKey }),
    ...(overrides.placesCursorSecret === undefined
      ? {}
      : { placesCursorSecretOverride: overrides.placesCursorSecret }),
    ...(overrides.googleRoutesApiKey === undefined
      ? {}
      : { googleRoutesApiKeyOverride: overrides.googleRoutesApiKey }),
  });
  if (admission === undefined) return undefined;
  const ids = new ProductionIds();
  const registry = new CandidateObservationRegistry(productionClockPort(clock), ids);
  const continuation =
    overrides.prepareTurn === undefined
      ? createFactoryContinuation({
          secret: admission.placesCursorSecret,
          now: overrides.epochNow ?? Date.now,
        })
      : undefined;
  const resolvedOverrides: RuntimeProductionOverrides = {
    ...overrides,
    placesEnabled: admission.placesEnabled,
    routesEnabled: admission.routesEnabled,
    lastTrainEnabled: admission.lastTrainEnabled,
    photosEnabled: admission.photosEnabled,
    ...(admission.googlePlacesApiKey === undefined
      ? {}
      : { googlePlacesApiKey: admission.googlePlacesApiKey }),
    ...(admission.placesCursorSecret === undefined
      ? {}
      : { placesCursorSecret: admission.placesCursorSecret }),
    ...(admission.googleRoutesApiKey === undefined
      ? {}
      : { googleRoutesApiKey: admission.googleRoutesApiKey }),
  };
  return makeOptions(
    devFixture ? { ...input, env: effectiveEnv } : input,
    resolvedOverrides,
    ids,
    registry,
    continuation,
    clock,
    monotonicNow,
  );
};
