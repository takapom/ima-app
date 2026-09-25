import { createPhotoTokenIssuer } from '@worker/adapters/out/security/photo-token-issuer';
import { CandidateObservationRegistry } from '@worker/application/candidate-registry/registry';
import type { createPlacesSearchContinuation } from '@worker/adapters/out/providers/places-search/continuation';
import { createLiveOpenAIProvider } from '@worker/adapters/out/providers/openai/model-provider';
import { OPENAI_PROVIDER_REQUEST_OPTIONS } from '@worker/adapters/out/providers/openai/provider-options';
import { createRuntimeReadAttemptSignalBridge } from '@worker/runtime/tool-reads/runtime-read-ports';
import { wrapRuntimeModelTrace } from '@worker/runtime/tracing/runtime-model-trace';
import { createRuntimeProviderTransportObserver } from '@worker/adapters/out/providers/telemetry/runtime-provider-observer';
import {
  createRuntimeTurnComposition,
  type RuntimeTurnCompositionCoreOptions,
} from '@worker/composition/runtime-turn-composition';
import { wrapRuntimeProductionCommit } from '@worker/runtime/context/runtime-production-context';
import { createFactoryRuntimeContext } from '@worker/runtime/context/runtime-production-context-factory';
import { RuntimeBudget } from '@worker/runtime/budget/runtime-budget';
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
} from '@worker/composition/runtime-production-support';
import {
  capabilitiesWithProviders,
  cardEvidenceResolver,
  type RuntimeProductionProviderAvailability,
} from '@worker/composition/runtime-production-provider-config';
import {
  hotPepperRuntimePolicy,
  hotPepperPhotoDisplayPolicy,
} from '@worker/composition/runtime-hot-pepper-policy';
import { configuredPhotoTokenCodec } from '@worker/composition/photo-token-configuration';
import { createPhotoTokenPreparer } from '@worker/runtime/response/photo-token-issuance';
import { configureRuntimeProductionSession } from '@worker/runtime/retention/runtime-production-session';
import type {
  RuntimeThinkConnectionOptions,
  RuntimeThinkTurnBuildRequest,
} from '@worker/runtime/turn-execution/runtime-think-connection';
import { defaultRuntimeModelContextPolicy } from '@worker/runtime/context/runtime-field-policy';
import { resolveRuntimeProductionReadCost } from '@worker/composition/runtime-production-read-cost';
import { createRuntimeProductionPlacePorts } from '@worker/composition/runtime-production-place-ports';
import { createFactoryContinuation } from '@worker/composition/runtime-production-continuation';
import { resolveRuntimeOperationalAdmission } from '@worker/composition/runtime-operational-admission';
import {
  devFixtureEnvironmentFor,
  devFixtureOverridesFor,
  isKeylessDevFixtureEnvironment,
} from '@worker/composition/runtime-dev-fixture';
import type { RuntimeRetentionContext } from '@worker/runtime/retention/runtime-retention';
import type {
  ProductionBuildInput,
  RuntimeProductionConnectionOptions,
  RuntimeProductionOverrides,
  RuntimeProductionTurnPlan,
} from '@worker/composition/runtime-production-types';

export type {
  ProductionBuildInput,
  RuntimeProductionConnectionOptions,
  RuntimeProductionOverrides,
  RuntimeProductionTurnPlan,
} from '@worker/composition/runtime-production-types';
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
  const modelFromConfiguredProvider = overrides.modelForTurn === undefined;
  const cardEvidence = cardEvidenceResolver(registry, input.context);
  const photoCodec = configuredPhotoTokenCodec(env);
  const preparePhotoTokens =
    photoCodec === undefined || input.request.deviceId === undefined
      ? undefined
      : createPhotoTokenPreparer({
          issuer: createPhotoTokenIssuer(photoCodec),
          registry,
          scope: productionScopeFor(input.context),
          deviceId: input.request.deviceId,
          sourceTurnId: input.request.turnId,
          sourceRevision: input.request.revision,
          photosEnabled: providerAvailability.placesEnabled,
          displayPolicyFor: hotPepperPhotoDisplayPolicy,
        });
  return {
    model: overrides.modelForTurn ?? createLiveOpenAIProvider(env).model,
    ...(modelFromConfiguredProvider ? { modelTraceProvider: 'openai' as const } : {}),
    providerOptions: OPENAI_PROVIDER_REQUEST_OPTIONS,
    registry,
    search,
    details,
    retention,
    historyRetention:
      input.request.conversationMemory === undefined ? context.historyRetention : [],
    modelContext:
      input.request.conversationMemory === undefined
        ? context.modelContext
        : {
            ...context.modelContext,
            history: [],
            conversationMemory: input.request.conversationMemory,
          },
    validationContext: (at) => ({
      ...validationContextFor(input.context, at.now),
      allowUnknownOpening: true,
    }),
    ids,
    hashes: productionHash,
    publicResponse: {
      textRetention: turnRetention,
      cardSetId,
      resolveCardEvidence: cardEvidence,
      ...(preparePhotoTokens === undefined ? {} : { preparePhotoTokens }),
    },
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
  const buildTurn = (request: RuntimeThinkTurnBuildRequest) => {
    if (request.runtimeInput === undefined) throw new Error('RUNTIME_INPUT_MISSING');
    const runtimeInput = { ...request.runtimeInput, turnId: request.turnId };
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
    const providerAvailability = { placesEnabled };
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
      ...(plan.historyRetention === undefined ? {} : { historyRetention: plan.historyRetention }),
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
        ...(plan.modelContext.fieldPolicy === undefined
          ? {}
          : { modelContextFieldPolicy: plan.modelContext.fieldPolicy }),
      },
      attemptSignalBridge: bridge,
      commit: input.commit,
      resolveReadCost: (read) => resolveRuntimeProductionReadCost(read, plan.registry),
      validationContext: plan.validationContext,
      persistMessages: () => Promise.resolve({ requestId: request.turnId, status: 'completed' }),
      idempotencyKey: runtimeInput.idempotencyKey,
      ...(overrides.turnObserver === undefined ? {} : { turnObserver: overrides.turnObserver }),
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
  const configuredOverrides = {
    ...hotPepperRuntimePolicy(input.overrides?.clock ?? productionClock),
    ...input.overrides,
  };
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
    ...(overrides.hotPepperApiKey === undefined
      ? {}
      : { hotPepperApiKeyOverride: overrides.hotPepperApiKey }),
    ...(overrides.placesCursorSecret === undefined
      ? {}
      : { placesCursorSecretOverride: overrides.placesCursorSecret }),
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
    ...(admission.hotPepperApiKey === undefined
      ? {}
      : { hotPepperApiKey: admission.hotPepperApiKey }),
    ...(admission.placesCursorSecret === undefined
      ? {}
      : { placesCursorSecret: admission.placesCursorSecret }),
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
