import type { CandidateObservationRegistry, PlaceDetailsPort, PlaceSearchPort } from '@ima/core';
import {
  createConfiguredHotPepperAdapter,
  type HotPepperEnvironment,
} from '../providers/hot-pepper/adapter';
import {
  createHotPepperDetailsOverlay,
  createHotPepperReuseFilter,
} from '../providers/hot-pepper/composition';
import { denyHotPepperFieldPolicy } from '../providers/hot-pepper/types';
import { normalizeGoogleOpeningHours } from '../providers/places/hours';
import { createPlacesDetailsAdapter } from '../providers/places-details/adapter';
import { createGooglePlaceDetailsTransport } from '../providers/places-details/transport';
import type { RuntimeProviderTransportObserver } from '../providers/telemetry/runtime-provider-trace-contract';
import { createPlacesSearchAdapter } from '../providers/places-search/adapter';
import type { createPlacesSearchContinuation } from '../providers/places-search/continuation';
import { createPlacesSearchRegistration } from '../providers/places-search/registration';
import { createGoogleTextSearchTransport } from '../providers/places-search/transport';
import type { RuntimeBudget } from './runtime-budget';
import { disabledDetailsPort, disabledSearchPort } from './runtime-disabled-provider-ports';
import {
  areaLabelFor,
  isConfiguredSecret,
  type RuntimeProductionProviderAvailability,
} from './runtime-production-provider-config';
import {
  capProductionObservationPolicy,
  defaultProductionObservationPolicy,
  productionClockPort,
} from './runtime-production-support';
import {
  createRuntimeSavedReferenceComposition,
  runtimeSavedReferenceNamespaceFor,
  type RuntimeSavedReferenceComposition,
} from './runtime-saved-reference-production';
import type { ProductionBuildInput, RuntimeProductionOverrides } from './runtime-production-types';
import type { ProductionIds } from './runtime-production-support';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hotPepperEnvironmentFor = (
  environment: unknown,
  apiKey: string | undefined,
): HotPepperEnvironment => {
  const source = isRecord(environment) ? environment : {};
  const result: {
    -readonly [Key in keyof HotPepperEnvironment]?: HotPepperEnvironment[Key];
  } = {};
  if ('IMA_RUNTIME_MODE' in source) result.IMA_RUNTIME_MODE = source.IMA_RUNTIME_MODE;
  if ('IMA_PROVIDER_HOTPEPPER' in source) {
    result.IMA_PROVIDER_HOTPEPPER = source.IMA_PROVIDER_HOTPEPPER;
  }
  if ('IMA_KILL_SWITCH' in source) result.IMA_KILL_SWITCH = source.IMA_KILL_SWITCH;
  if (apiKey !== undefined) {
    result.HOTPEPPER_API_KEY = apiKey;
  } else if ('HOTPEPPER_API_KEY' in source) {
    result.HOTPEPPER_API_KEY = source.HOTPEPPER_API_KEY;
  }
  return result;
};

export type RuntimeProductionPlacePorts = {
  readonly search: PlaceSearchPort;
  readonly details: PlaceDetailsPort;
  readonly savedReference?: RuntimeSavedReferenceComposition;
};

export const createRuntimeProductionPlacePorts = (input: {
  readonly build: ProductionBuildInput;
  readonly env: unknown;
  readonly clock: () => string;
  readonly overrides: RuntimeProductionOverrides;
  readonly ids: ProductionIds;
  readonly registry: CandidateObservationRegistry;
  readonly continuation: ReturnType<typeof createPlacesSearchContinuation> | undefined;
  readonly areaByCandidate: Map<string, string>;
  readonly fixedSessionExpiresAt: string;
  readonly budget: RuntimeBudget;
  readonly providerAvailability: RuntimeProductionProviderAvailability;
  readonly providerTraceObserver?: RuntimeProviderTransportObserver;
}): RuntimeProductionPlacePorts => {
  let search: PlaceSearchPort = disabledSearchPort;
  let details: PlaceDetailsPort = disabledDetailsPort;
  if (!input.providerAvailability.placesEnabled) return { search, details };

  const apiKey = input.overrides.googlePlacesApiKey;
  const cursorSecret = input.overrides.placesCursorSecret;
  if (!isConfiguredSecret(apiKey) || !isConfiguredSecret(cursorSecret)) {
    throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');
  }
  if (input.continuation === undefined) throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');

  const policy = capProductionObservationPolicy(
    input.overrides.observationPolicy ??
      defaultProductionObservationPolicy(input.clock, input.fixedSessionExpiresAt),
    input.fixedSessionExpiresAt,
  );
  const detailsPolicy = capProductionObservationPolicy(
    input.overrides.detailsObservationPolicy ?? policy,
    input.fixedSessionExpiresAt,
  );
  const registration = createPlacesSearchRegistration({
    registry: input.registry,
    clock: productionClockPort(input.clock),
    observationPolicy: policy,
    ...(input.overrides.candidateIdentityObserver === undefined
      ? {}
      : { observeCandidate: input.overrides.candidateIdentityObserver }),
  });
  const searchAdapter = createPlacesSearchAdapter({
    transport: createGoogleTextSearchTransport({
      apiKey,
      timeoutMs: 3_000,
      ...(input.overrides.fetcher === undefined ? {} : { fetcher: input.overrides.fetcher }),
      ...(input.providerTraceObserver === undefined
        ? {}
        : { observer: input.providerTraceObserver }),
    }),
    continuation: input.continuation,
    registration,
    nextSearchId: () => input.ids.nextSearchId(),
    clock: input.clock,
    normalizeOpeningHours: normalizeGoogleOpeningHours,
    signalFor: input.build.attemptSignalBridge.signalFor,
    ...(input.overrides.currentOriginRefFor === undefined
      ? {}
      : { originRefFor: input.overrides.currentOriginRefFor }),
  });
  search = {
    search: async (searchInput, context, execution, cancellation) => {
      const result = await searchAdapter.search(searchInput, context, execution, cancellation);
      if (result.status === 'ok' || result.status === 'partial') {
        for (const candidate of result.data.candidates) {
          input.areaByCandidate.set(candidate.candidateId, result.data.applied.areaDescription);
        }
      }
      return result;
    },
  };

  const detailsTransport = createGooglePlaceDetailsTransport({
    apiKey,
    timeoutMs: 4_000,
    ...(input.overrides.fetcher === undefined ? {} : { fetcher: input.overrides.fetcher }),
    ...(input.providerTraceObserver === undefined ? {} : { observer: input.providerTraceObserver }),
  });
  const hotPepperFieldPolicy = input.overrides.hotPepperFieldPolicy;
  const hotPepperProviderInputPolicy = input.overrides.hotPepperProviderInputPolicy;
  const hotPepperObservationPolicy =
    input.overrides.hotPepperObservationPolicy === undefined
      ? undefined
      : capProductionObservationPolicy(
          input.overrides.hotPepperObservationPolicy,
          input.fixedSessionExpiresAt,
        );
  const hotPepperCandidateReferenceFor = input.overrides.hotPepperCandidateReferenceFor;
  const hotPepper =
    input.providerAvailability.hotPepperEnabled &&
    hotPepperFieldPolicy !== undefined &&
    hotPepperProviderInputPolicy !== undefined &&
    hotPepperObservationPolicy !== undefined &&
    hotPepperCandidateReferenceFor !== undefined
      ? createConfiguredHotPepperAdapter(
          hotPepperEnvironmentFor(input.env, input.overrides.hotPepperApiKey),
          {
            policy: hotPepperFieldPolicy,
            providerInputPolicy: hotPepperProviderInputPolicy,
            ...(input.overrides.hotPepperTransport === undefined
              ? {}
              : { transport: input.overrides.hotPepperTransport }),
            ...(input.overrides.hotPepperFetcher === undefined
              ? {}
              : { fetcher: input.overrides.hotPepperFetcher }),
            ...(input.providerTraceObserver === undefined
              ? {}
              : { observer: input.providerTraceObserver }),
          },
        )
      : undefined;
  const savedNamespace = runtimeSavedReferenceNamespaceFor(input.env);
  const savedReference =
    savedNamespace === undefined
      ? undefined
      : createRuntimeSavedReferenceComposition({
          namespace: savedNamespace,
          ownerScopeRef: input.build.context.ownerScopeRef,
          registry: input.registry,
          transport: detailsTransport,
          clock: input.clock,
          sessionExpiresAt: () => input.fixedSessionExpiresAt,
          reserveProviderRequest: () => input.budget.reserveProviderRequest().ok,
          ...(input.build.request.signal === undefined
            ? {}
            : { requestSignal: input.build.request.signal }),
          signalFor: input.build.attemptSignalBridge.signalFor,
        });
  const placesDetails = createPlacesDetailsAdapter({
    transport: detailsTransport,
    registry: input.registry,
    clock: productionClockPort(input.clock),
    observationPolicy: detailsPolicy,
    areaLabelFor: (candidate, context) => areaLabelFor(candidate, context, input.areaByCandidate),
    signalFor: input.build.attemptSignalBridge.signalFor,
    ...(savedReference === undefined ? {} : { savedReferenceHandoff: savedReference.handoff }),
    ...(input.overrides.currentOriginRefFor === undefined
      ? {}
      : { originRefFor: input.overrides.currentOriginRefFor }),
  });
  if (
    hotPepper !== undefined &&
    hotPepperFieldPolicy !== undefined &&
    hotPepperObservationPolicy !== undefined &&
    hotPepperCandidateReferenceFor !== undefined
  ) {
    details = createHotPepperDetailsOverlay({
      inner: placesDetails,
      adapter: hotPepper,
      registry: input.registry,
      clock: productionClockPort(input.clock),
      observationPolicy: hotPepperObservationPolicy,
      fieldPolicy: hotPepperFieldPolicy,
      candidateReferenceFor: hotPepperCandidateReferenceFor,
      reserveProviderRequest: () => input.budget.reserveProviderRequest().ok,
      signalFor: input.build.attemptSignalBridge.signalFor,
    });
  } else {
    details = createHotPepperReuseFilter(placesDetails, denyHotPepperFieldPolicy, 'live');
  }
  return { search, details, ...(savedReference === undefined ? {} : { savedReference }) };
};
