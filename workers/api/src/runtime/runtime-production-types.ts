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
import type { JourneyServiceDateContextBuilder } from '../providers/last-train/port';
import type { LastTrainObservationPolicy } from '../providers/last-train/registration';
import type { PhotoTokenPreparerDependencies } from '../providers/photo/issuance';
import type { PhotoReferenceStoreResolver } from '../providers/photo/types';
import type { PlacesDetailsObservationPolicy } from '../providers/places-details/adapter-types';
import type { PlacesSearchObservationPolicy } from '../providers/places-search/registration';
import type { WalkingRouteObservationPolicy } from '../providers/routes/registration';
import type { RouteWaypointResolver } from '../providers/routes/resolver';
import type { RuntimeReadAttemptSignalBridge } from './runtime-read-ports';
import type {
  RuntimeCompositionModelContext,
  RuntimeCompositionValidationContext,
  RuntimePublicResponseDependencies,
} from './runtime-turn-composition';
import type { RuntimeProductionContextPersistence } from './runtime-production-context-reference';
import type { ProductionRetentionSource } from './runtime-production-support';
import type {
  RuntimeJourneyDataset,
  RuntimeLastTrainCompositionOptions,
} from './runtime-provider-composition';
import type { RuntimeProductionProviderComposition } from './runtime-production-providers';
import type { RuntimeRetentionContext } from './runtime-retention';
import type { RuntimeModelGuardModel } from './runtime-model-guard';
import type { RuntimeThinkTurnBuildRequest } from './runtime-think-connection';

export type ProductionBuildInput = {
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
  /** Host-owned provider capability gate; retention policy is evaluated separately. */
  readonly placesEnabled?: boolean;
  /** Host-owned gate; an operational flag alone never invents route configuration. */
  readonly routesEnabled?: boolean;
  readonly lastTrainEnabled?: boolean;
  /** Host-owned photo issuance gate; the Places flag alone does not publish photos. */
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
  readonly retention?: ProductionRetentionSource;
  readonly modelContextFieldPolicy?: ModelContextFieldPolicy;
  readonly threadCreatedAt?: string;
  readonly contextPersistence?: RuntimeProductionContextPersistence;
  readonly clock?: () => string;
  readonly monotonicNow?: () => number;
  readonly epochNow?: () => number;
};

export type RuntimeProductionConnectionOptions = {
  readonly env: unknown;
  readonly commit: CommitPort;
  readonly overrides?: RuntimeProductionOverrides;
};
