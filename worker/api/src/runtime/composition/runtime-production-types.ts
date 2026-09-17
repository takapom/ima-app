import type { HotPepperTransport } from '@api/providers/hot-pepper/transport';
import type { TurnConfig } from '@cloudflare/think';
import type { ThreadTurnRequest } from '@ima/contracts';
import type {
  CandidateRecord,
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
import type { PlacesSearchObservationPolicy } from '@api/providers/places-search/registration';
import type { RuntimeReadAttemptSignalBridge } from '@api/runtime/tool-reads/runtime-read-ports';
import type {
  RuntimeCompositionModelContext,
  RuntimeCompositionValidationContext,
  RuntimePublicResponseDependencies,
} from '@api/runtime/turn-execution/runtime-turn-composition';
import type { RuntimeProductionContextPersistence } from '@api/runtime/context/runtime-production-context-reference';
import type { ProductionRetentionSource } from '@api/runtime/composition/runtime-production-support';
import type { RuntimeRetentionContext } from '@api/runtime/retention/runtime-retention';
import type { RuntimeModelGuardModel } from '@api/runtime/turn-execution/runtime-model-guard';
import type { RuntimeModelTraceSink } from '@api/runtime/tracing/runtime-model-trace';
import type { RuntimeThinkTurnBuildRequest } from '@api/runtime/turn-execution/runtime-think-connection';
import type { RuntimeProviderTraceSink } from '@api/providers/telemetry/runtime-provider-trace';
import type { SavedPlaceReferenceResolver } from '@api/tools/types';

export type ProductionBuildInput = {
  readonly request: RuntimeThinkTurnBuildRequest;
  readonly runtimeInput: ThreadTurnRequest;
  readonly context: HarnessContext;
  readonly attemptSignalBridge: RuntimeReadAttemptSignalBridge;
};

export type RuntimeProductionTurnPlan = {
  readonly model: RuntimeModelGuardModel;
  /** Set only when this plan constructed the configured OpenAI provider itself. */
  readonly modelTraceProvider?: 'openai';
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
  readonly savedPlaceReferenceResolver?: SavedPlaceReferenceResolver;
  readonly onCommitted?: (response: unknown) => void;
};

export type RuntimeProductionOverrides = {
  readonly hotPepperApiKey?: string;
  readonly hotPepperTransport?: HotPepperTransport;
  readonly prepareTurn?: (input: ProductionBuildInput) => RuntimeProductionTurnPlan;
  readonly modelForTurn?: RuntimeModelGuardModel;
  /** Optional Worker-owned sink for one trace record per actual SDK model call. */
  readonly modelTraceSink?: RuntimeModelTraceSink;
  /** Optional Worker-owned sink for one trace record per actual provider HTTP call. */
  readonly providerTraceSink?: RuntimeProviderTraceSink;
  /** Optional host-owned observer for exact provider candidate identity mapping. */
  readonly candidateIdentityObserver?: (
    record: Pick<CandidateRecord, 'provider' | 'recordRef' | 'candidateId'>,
  ) => void;
  readonly placesCursorSecret?: string;
  readonly fetcher?: typeof fetch;
  readonly observationPolicy?: PlacesSearchObservationPolicy;
  readonly detailsObservationPolicy?: PlacesSearchObservationPolicy;
  readonly placesEnabled?: boolean;
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
