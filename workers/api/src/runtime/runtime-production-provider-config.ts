import type {
  CandidateObservationRegistryPort,
  CandidateRecord,
  CapabilitySnapshot,
  DetailField,
  HarnessContext,
  PlaceDetailsPort,
  ToolExecutionContext,
} from '@ima/core';
import type { PhotoReferenceRpc } from '../providers/photo/rpc';
import { createPhotoReferenceStoreResolver } from '../providers/photo/rpc';
import { createPhotoTokenCodec } from '../providers/photo/token';
import type { PhotoTokenPreparerDependencies } from '../providers/photo/issuance';
import type { PhotoReferenceStoreResolver } from '../providers/photo/types';
import type { RuntimePublicResponseDependencies } from './runtime-turn-composition';
import { productionScopeFor, productionSecret } from './runtime-production-support';
import { createRuntimeRouteBudgetBoundary } from '../providers/routes/budget';
import type { WalkingRouteObservationPolicy } from '../providers/routes/registration';
import type { RouteWaypointResolver } from '../providers/routes/resolver';
import type { JourneyServiceDateContextBuilder } from '../providers/last-train/port';
import type { LastTrainObservationPolicy } from '../providers/last-train/registration';
import type {
  RuntimeJourneyDataset,
  RuntimeLastTrainCompositionOptions,
  RuntimeLastTrainRevisionState,
} from './runtime-provider-composition';
import {
  createRuntimeProductionProviderComposition,
  type RuntimeProductionProviderComposition,
} from './runtime-production-providers';
import type { RuntimeBudget } from './runtime-budget';

export type RuntimeProductionProviderAvailability = {
  readonly activeJourneyRevision: number | null | undefined;
  readonly placesEnabled: boolean;
  readonly lastTrainEnabled: boolean;
  readonly routesEnabled: boolean;
  readonly photosEnabled: boolean;
};

export const isConfiguredSecret = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

export type RuntimeProductionAvailabilityConfiguration = RuntimeProductionPhotoConfiguration & {
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
};

export const runtimeProductionProviderAvailabilityFor = (
  input: RuntimeProductionAvailabilityOptions,
): RuntimeProductionProviderAvailability => {
  const routesEnabled =
    input.configuration.routesEnabled === true &&
    isConfiguredSecret(input.configuration.googleRoutesApiKey) &&
    input.configuration.routeObservationPolicy !== undefined &&
    input.configuration.currentOriginRefFor !== undefined;
  const currentOriginRef = input.configuration.currentOriginRefFor?.(input.context);
  const lastTrainEnabled =
    input.configuration.lastTrainEnabled !== false &&
    routesEnabled &&
    input.activeJourneyRevision !== undefined &&
    input.activeJourneyRevision !== null &&
    input.configuration.journeyDataset !== undefined &&
    input.configuration.buildServiceDateContext !== undefined &&
    input.configuration.lastTrainObservationPolicy !== undefined &&
    input.configuration.fromStationRefFor !== undefined &&
    input.configuration.resolveStationWaypoint !== undefined &&
    currentOriginRef !== undefined &&
    currentOriginRef.trim().length > 0;
  const photoSecret =
    input.configuration.photoTokenSecret ?? productionSecret(input.env, 'PHOTO_TOKEN_SECRET');
  const photosEnabled =
    input.configuration.photosEnabled === true &&
    input.deviceId !== undefined &&
    input.configuration.photoDisplayPolicyFor !== undefined &&
    isConfiguredSecret(photoSecret) &&
    photoReferenceAvailable(input.env, input.configuration.photoReferenceResolver);
  return {
    activeJourneyRevision: input.activeJourneyRevision,
    placesEnabled: input.placesEnabled,
    lastTrainEnabled,
    routesEnabled,
    photosEnabled,
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

export const cardEvidenceResolver =
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
};

/** Builds the host-only provider graph after capability and secret gates have been evaluated. */
export const createRuntimeProductionProviders = (
  input: RuntimeProductionProviderAssemblyOptions,
): RuntimeProductionProviderComposition => {
  const routeExecutionFor = (execution: ToolExecutionContext): ToolExecutionContext => ({
    ...execution,
    operation: 'walking_route',
  });
  const route =
    input.availability.routesEnabled &&
    input.googleRoutesApiKey !== undefined &&
    input.routeObservationPolicy !== undefined &&
    input.currentOriginRefFor !== undefined
      ? {
          apiKey: input.googleRoutesApiKey,
          budget: createRuntimeRouteBudgetBoundary(input.budget),
          clock: input.clock,
          resolveContext: () => input.context,
          ...(input.resolveStationWaypoint === undefined
            ? {}
            : { resolveStationWaypoint: input.resolveStationWaypoint }),
          currentOriginRefFor: input.currentOriginRefFor,
          observationPolicy: input.routeObservationPolicy,
          ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
          ...(input.requestSignal === undefined ? {} : { signal: input.requestSignal }),
          signalFor: input.signalFor,
          routeExecutionFor,
        }
      : undefined;
  const currentOriginRef = input.currentOriginRefFor?.(input.context);
  const lastTrain =
    input.availability.lastTrainEnabled &&
    input.activeJourneyRevision !== undefined &&
    input.activeJourneyRevision !== null &&
    input.journeyDataset !== undefined &&
    input.buildServiceDateContext !== undefined &&
    input.lastTrainObservationPolicy !== undefined &&
    input.fromStationRefFor !== undefined &&
    input.resolveStationWaypoint !== undefined &&
    currentOriginRef !== undefined &&
    currentOriginRef.trim().length > 0
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
