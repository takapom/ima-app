import type {
  CandidateObservationRegistryPort,
  CandidateRecord,
  CapabilitySnapshot,
  DetailField,
  HarnessContext,
  PlaceDetailsPort,
  ToolExecutionContext,
} from '@ima/core';
import type { PhotoReferenceRpc } from '../../providers/photo/rpc';
import { createPhotoReferenceStoreResolver } from '../../providers/photo/rpc';
import { createPhotoTokenCodec } from '../../providers/photo/token';
import type { PhotoTokenPreparerDependencies } from '../../providers/photo/issuance';
import type { PhotoReferenceStoreResolver } from '../../providers/photo/types';
import type { RuntimePublicResponseDependencies } from '../turn-execution/runtime-turn-composition';
import { productionScopeFor, productionSecret } from './runtime-production-support';
import { createRuntimeRouteBudgetBoundary } from '../../providers/routes/budget';
import type { WalkingRouteObservationPolicy } from '../../providers/routes/registration';
import type { RouteWaypointResolver } from '../../providers/routes/resolver';
import type { RuntimeProviderTransportObserver } from '../../providers/telemetry/runtime-provider-trace-contract';
import type { JourneyServiceDateContextBuilder } from '../../providers/last-train/port';
import type { LastTrainObservationPolicy } from '../../providers/last-train/registration';
import { operationalCapabilityMode, resolveOperationalFlags } from '../../telemetry/flags';
import type { RuntimeProductionHotPepperConfiguration } from '../../providers/hot-pepper/composition';
import {
  denyHotPepperFieldPolicy,
  type HotPepperFieldPolicy,
  type HotPepperRuntimeMode,
} from '../../providers/hot-pepper/types';
import { reprojectHotPepperObservationRetention } from '../../providers/hot-pepper/policy-projection';
import type {
  RuntimeJourneyDataset,
  RuntimeLastTrainCompositionOptions,
  RuntimeLastTrainRevisionState,
} from '../runtime-provider-composition';
import {
  createRuntimeProductionProviderComposition,
  type RuntimeProductionProviderComposition,
} from './runtime-production-providers';
import type { RuntimeBudget } from '../budget/runtime-budget';

export type RuntimeProductionProviderAvailability = {
  readonly activeJourneyRevision: number | null | undefined;
  readonly placesEnabled: boolean;
  readonly lastTrainEnabled: boolean;
  readonly routesEnabled: boolean;
  readonly photosEnabled: boolean;
  readonly hotPepperEnabled: boolean;
};

export const isConfiguredSecret = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

export type RuntimeProductionAvailabilityConfiguration = RuntimeProductionPhotoConfiguration &
  RuntimeProductionHotPepperConfiguration & {
    /** Host-owned flag; omitted only by direct unit fixtures, where the capability is explicit. */
    readonly lastTrainEnabled?: boolean;
    readonly routesEnabled?: boolean;
    readonly googleRoutesApiKey?: string;
    readonly routeObservationPolicy?: WalkingRouteObservationPolicy;
    readonly currentOriginRefFor?: (context: HarnessContext) => string | undefined;
    readonly journeyDataset?: RuntimeJourneyDataset;
    readonly buildServiceDateContext?: JourneyServiceDateContextBuilder;
    readonly lastTrainObservationPolicy?: LastTrainObservationPolicy;
    readonly fromStationRefFor?: RuntimeLastTrainCompositionOptions['fromStationRefFor'];
    readonly resolveStationWaypoint?: RouteWaypointResolver;
  };

export type RuntimeProductionAvailabilityOptions = {
  readonly env: unknown;
  readonly context: HarnessContext;
  readonly placesEnabled: boolean;
  readonly activeJourneyRevision: number | null | undefined;
  readonly configuration: RuntimeProductionAvailabilityConfiguration;
  readonly deviceId?: string;
  /** Reuse the factory's one origin evaluation instead of calling the resolver again. */
  readonly routeReadiness?: RuntimeProductionRouteReadiness;
};

export type RuntimeProductionRouteReadiness = {
  readonly enabled: boolean;
  readonly currentOriginRef: string | null;
};

const routesConfiguredFor = (configuration: RuntimeProductionAvailabilityConfiguration): boolean =>
  configuration.routesEnabled === true &&
  isConfiguredSecret(configuration.googleRoutesApiKey) &&
  configuration.routeObservationPolicy !== undefined &&
  configuration.currentOriginRefFor !== undefined;

export const runtimeProductionRouteReadinessFor = (
  configuration: RuntimeProductionAvailabilityConfiguration,
  context: HarnessContext,
): RuntimeProductionRouteReadiness => {
  const currentOriginRefFor = configuration.currentOriginRefFor;
  if (!routesConfiguredFor(configuration) || currentOriginRefFor === undefined) {
    return { enabled: false, currentOriginRef: null };
  }
  try {
    const currentOriginRef = currentOriginRefFor(context);
    return currentOriginRef !== undefined && currentOriginRef.trim().length > 0
      ? { enabled: true, currentOriginRef }
      : { enabled: false, currentOriginRef: null };
  } catch {
    return { enabled: false, currentOriginRef: null };
  }
};

export type RuntimeProductionLastTrainReadiness = {
  readonly dataset: RuntimeJourneyDataset;
  readonly currentOriginRef: string;
};

export const runtimeProductionLastTrainReadinessFor = (
  configuration: RuntimeProductionAvailabilityConfiguration,
  context: HarnessContext,
  routeReadiness = runtimeProductionRouteReadinessFor(configuration, context),
): RuntimeProductionLastTrainReadiness | undefined => {
  if (
    configuration.lastTrainEnabled === false ||
    !routeReadiness.enabled ||
    routeReadiness.currentOriginRef === null ||
    configuration.journeyDataset === undefined ||
    configuration.buildServiceDateContext === undefined ||
    configuration.lastTrainObservationPolicy === undefined ||
    configuration.fromStationRefFor === undefined ||
    configuration.resolveStationWaypoint === undefined
  ) {
    return undefined;
  }
  return {
    dataset: configuration.journeyDataset,
    currentOriginRef: routeReadiness.currentOriginRef,
  };
};

export const runtimeProductionProviderAvailabilityFor = (
  input: RuntimeProductionAvailabilityOptions,
): RuntimeProductionProviderAvailability => {
  const routeReadiness =
    input.routeReadiness ?? runtimeProductionRouteReadinessFor(input.configuration, input.context);
  const routesEnabled = routeReadiness.enabled;
  const lastTrainReadiness = runtimeProductionLastTrainReadinessFor(
    input.configuration,
    input.context,
    routeReadiness,
  );
  const lastTrainEnabled =
    input.activeJourneyRevision !== undefined &&
    input.activeJourneyRevision !== null &&
    lastTrainReadiness !== undefined;
  const photoSecret =
    input.configuration.photoTokenSecret ?? productionSecret(input.env, 'PHOTO_TOKEN_SECRET');
  const photosEnabled =
    input.configuration.photosEnabled === true &&
    input.deviceId !== undefined &&
    input.configuration.photoDisplayPolicyFor !== undefined &&
    isConfiguredSecret(photoSecret) &&
    photoReferenceAvailable(input.env, input.configuration.photoReferenceResolver);
  const hotPepperMode = operationalCapabilityMode(resolveOperationalFlags(input.env), 'hotpepper');
  const hotPepperCredentialReady =
    hotPepperMode === 'fixture'
      ? input.configuration.hotPepperTransport !== undefined
      : hotPepperMode === 'live'
        ? isConfiguredSecret(
            input.configuration.hotPepperApiKey ?? productionSecret(input.env, 'HOTPEPPER_API_KEY'),
          )
        : false;
  const hotPepperEnabled =
    input.placesEnabled &&
    input.configuration.hotPepperEnabled === true &&
    input.configuration.hotPepperCandidateReferenceFor !== undefined &&
    input.configuration.hotPepperFieldPolicy !== undefined &&
    input.configuration.hotPepperProviderInputPolicy !== undefined &&
    input.configuration.hotPepperObservationPolicy !== undefined &&
    hotPepperCredentialReady;
  return {
    activeJourneyRevision: input.activeJourneyRevision,
    placesEnabled: input.placesEnabled,
    lastTrainEnabled,
    routesEnabled,
    photosEnabled,
    hotPepperEnabled,
  };
};

export const capabilitiesWithProviders = (
  base: CapabilitySnapshot,
  availability: RuntimeProductionProviderAvailability,
): CapabilitySnapshot => {
  const detailFields = [...base.detailFields];
  if (availability.photosEnabled && !detailFields.includes('photos')) detailFields.push('photos');
  if (availability.routesEnabled && !detailFields.includes('walking_route')) {
    detailFields.push('walking_route');
  }
  if (availability.lastTrainEnabled && !detailFields.includes('last_train')) {
    detailFields.push('last_train');
  }
  if (availability.hotPepperEnabled && !detailFields.includes('facilities')) {
    detailFields.push('facilities');
  }
  return {
    ...base,
    detailFields,
    walkingRoute: availability.routesEnabled,
    lastTrain: availability.lastTrainEnabled,
  };
};

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

export const hotPepperRuntimeModeFor = (env: unknown): HotPepperRuntimeMode | undefined => {
  const mode = operationalCapabilityMode(resolveOperationalFlags(env), 'hotpepper');
  return mode === 'fixture' || mode === 'live' ? mode : undefined;
};

export type RuntimeCardEvidenceResolverOptions = {
  readonly hotPepperFieldPolicy?: HotPepperFieldPolicy;
  readonly hotPepperMode?: HotPepperRuntimeMode;
};

export const cardEvidenceResolver =
  (
    registry: Pick<CandidateObservationRegistryPort, 'readObservation'>,
    context: HarnessContext,
    options: RuntimeCardEvidenceResolverOptions = {},
  ): NonNullable<RuntimePublicResponseDependencies['resolveCardEvidence']> =>
  (candidateId, evidenceId) => {
    const observation = registry.readObservation(productionScopeFor(context), evidenceId);
    if (observation === undefined || observation.candidateId !== candidateId) return undefined;
    const field = detailFieldFor(observation.field);
    if (field === undefined) return undefined;
    const retention = reprojectHotPepperObservationRetention(
      options.hotPepperFieldPolicy ?? denyHotPepperFieldPolicy,
      options.hotPepperMode ?? 'live',
      observation.field,
      observation.sources,
      observation.retention,
    );
    if (retention === undefined) return undefined;
    return {
      observationId: observation.observationId,
      candidateId: observation.candidateId,
      field,
      sources: observation.sources,
      retention,
    };
  };

export const areaLabelFor = (
  candidate: Readonly<CandidateRecord>,
  _context: HarnessContext,
  areaByCandidate: ReadonlyMap<string, string>,
): string => areaByCandidate.get(candidate.candidateId) ?? '検索結果の地域';

type PhotoThreadNamespace = {
  readonly getByName: (threadId: string) => unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPhotoThreadNamespace = (value: unknown): value is PhotoThreadNamespace =>
  isRecord(value) && typeof value.getByName === 'function';

const isPhotoReferenceRpc = (value: unknown): value is PhotoReferenceRpc =>
  isRecord(value) &&
  typeof value.putPhotoReference === 'function' &&
  typeof value.getPhotoReference === 'function';

const photoReferenceResolverFor = (
  env: unknown,
  override: PhotoReferenceStoreResolver | undefined,
): PhotoReferenceStoreResolver | undefined => {
  if (override !== undefined) return override;
  if (!isRecord(env) || !isPhotoThreadNamespace(env.THREADS)) return undefined;
  const threads = env.THREADS;
  return createPhotoReferenceStoreResolver((threadId) => {
    const stub = threads.getByName(threadId);
    if (!isPhotoReferenceRpc(stub)) throw new Error('RUNTIME_PHOTO_THREADS_UNAVAILABLE');
    return stub;
  });
};

export type RuntimeProductionPhotoConfiguration = {
  readonly photosEnabled?: boolean;
  readonly photoTokenSecret?: string;
  readonly photoReferenceResolver?: PhotoReferenceStoreResolver;
  readonly photoDisplayPolicyFor?: PhotoTokenPreparerDependencies['displayPolicyFor'];
};

export const photoReferenceAvailable = (
  env: unknown,
  override: PhotoReferenceStoreResolver | undefined,
): boolean => photoReferenceResolverFor(env, override) !== undefined;

export const photoDependenciesFor = (input: {
  readonly env: unknown;
  readonly configuration: RuntimeProductionPhotoConfiguration;
  readonly registry: CandidateObservationRegistryPort;
  readonly context: HarnessContext;
  readonly deviceId?: string;
}): PhotoTokenPreparerDependencies | undefined => {
  if (
    input.configuration.photosEnabled !== true ||
    input.deviceId === undefined ||
    input.configuration.photoDisplayPolicyFor === undefined
  ) {
    return undefined;
  }
  const secret =
    input.configuration.photoTokenSecret ?? productionSecret(input.env, 'PHOTO_TOKEN_SECRET');
  const resolver = photoReferenceResolverFor(input.env, input.configuration.photoReferenceResolver);
  if (secret === undefined || resolver === undefined) return undefined;
  try {
    const codec = createPhotoTokenCodec({ secret, referenceResolver: resolver });
    return {
      registry: input.registry,
      scope: productionScopeFor(input.context),
      codec,
      deviceId: input.deviceId,
      sourceTurnId: input.context.turnId,
      sourceRevision: input.context.revision,
      photosEnabled: true,
      displayPolicyFor: input.configuration.photoDisplayPolicyFor,
    };
  } catch {
    return undefined;
  }
};

export type RuntimeProductionProviderAssemblyOptions = {
  readonly availability: RuntimeProductionProviderAvailability;
  readonly activeJourneyRevision: number | null | undefined;
  readonly baseDetails: PlaceDetailsPort;
  readonly registry: CandidateObservationRegistryPort;
  readonly context: HarnessContext;
  readonly clock: () => string;
  readonly budget: RuntimeBudget;
  readonly requestSignal?: AbortSignal;
  readonly signalFor: (execution: ToolExecutionContext) => AbortSignal | undefined;
  readonly providerTraceObserver?: RuntimeProviderTransportObserver;
  readonly fetcher?: typeof fetch;
  readonly googleRoutesApiKey?: string;
  readonly routeObservationPolicy?: WalkingRouteObservationPolicy;
  readonly resolveStationWaypoint?: RouteWaypointResolver;
  readonly currentOriginRefFor?: (context: HarnessContext) => string | undefined;
  readonly journeyDataset?: RuntimeJourneyDataset;
  readonly buildServiceDateContext?: JourneyServiceDateContextBuilder;
  readonly lastTrainObservationPolicy?: LastTrainObservationPolicy;
  readonly fromStationRefFor?: RuntimeLastTrainCompositionOptions['fromStationRefFor'];
  readonly revisionState: RuntimeLastTrainRevisionState;
  readonly photoConfiguration: RuntimeProductionPhotoConfiguration;
  readonly env: unknown;
  readonly deviceId?: string;
  readonly currentOriginRef?: string | null;
};

/** Builds the host-only provider graph after capability and secret gates have been evaluated. */
export const createRuntimeProductionProviders = (
  input: RuntimeProductionProviderAssemblyOptions,
): RuntimeProductionProviderComposition => {
  const routeExecutionFor = (execution: ToolExecutionContext): ToolExecutionContext => ({
    ...execution,
    operation: 'walking_route',
  });
  const currentOriginRef =
    input.currentOriginRef !== undefined
      ? (input.currentOriginRef ?? undefined)
      : input.availability.routesEnabled
        ? (() => {
            try {
              return input.currentOriginRefFor?.(input.context);
            } catch {
              return undefined;
            }
          })()
        : undefined;
  const route =
    input.availability.routesEnabled &&
    input.googleRoutesApiKey !== undefined &&
    input.routeObservationPolicy !== undefined &&
    input.currentOriginRefFor !== undefined &&
    currentOriginRef !== undefined
      ? {
          apiKey: input.googleRoutesApiKey,
          budget: createRuntimeRouteBudgetBoundary(input.budget),
          clock: input.clock,
          resolveContext: () => input.context,
          ...(input.resolveStationWaypoint === undefined
            ? {}
            : { resolveStationWaypoint: input.resolveStationWaypoint }),
          currentOriginRefFor: () => currentOriginRef,
          observationPolicy: input.routeObservationPolicy,
          ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
          ...(input.requestSignal === undefined ? {} : { signal: input.requestSignal }),
          signalFor: input.signalFor,
          routeExecutionFor,
          ...(input.providerTraceObserver === undefined
            ? {}
            : { providerTraceObserver: input.providerTraceObserver }),
        }
      : undefined;
  const lastTrain =
    input.availability.lastTrainEnabled &&
    input.activeJourneyRevision !== undefined &&
    input.activeJourneyRevision !== null &&
    input.journeyDataset !== undefined &&
    input.buildServiceDateContext !== undefined &&
    input.lastTrainObservationPolicy !== undefined &&
    input.fromStationRefFor !== undefined &&
    input.resolveStationWaypoint !== undefined &&
    currentOriginRef !== undefined
      ? {
          activeRevision: input.activeJourneyRevision,
          dataset: input.journeyDataset,
          buildServiceDateContext: input.buildServiceDateContext,
          clock: input.clock,
          currentOriginRef,
          routeExecutionFor,
          observationPolicy: input.lastTrainObservationPolicy,
          fromStationRefFor: input.fromStationRefFor,
          executionForLastTrain: routeExecutionFor,
          registry: input.registry,
          revisionState: input.revisionState,
          ...(input.requestSignal === undefined ? {} : { signal: input.requestSignal }),
        }
      : undefined;
  const photos = photoDependenciesFor({
    env: input.env,
    configuration: input.photoConfiguration,
    registry: input.registry,
    context: input.context,
    ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
  });
  return createRuntimeProductionProviderComposition({
    baseDetails: input.baseDetails,
    registry: input.registry,
    clock: input.clock,
    ...(route === undefined ? {} : { route }),
    ...(lastTrain === undefined ? {} : { lastTrain }),
    ...(photos === undefined ? {} : { photos }),
  });
};
