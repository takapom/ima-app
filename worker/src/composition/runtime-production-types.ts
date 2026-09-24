import type { HotPepperTransport } from '@worker/adapters/out/providers/hot-pepper/transport';
import type { TurnConfig } from '@cloudflare/think';
import type { ThreadTurnRequest } from '@ima/contracts';
import type { CandidateRecord } from '@worker/domain/candidates/registry';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { CommitHashPort, CommitPort } from '@worker/application/ports/commit';
import type { HarnessContext, IdPort } from '@worker/application/ports/context';
import type { ModelContextFieldPolicy } from '@worker/application/model-context/model-context-policy';
import type { PlaceDetailsPort, PlaceSearchPort } from '@worker/application/ports/operations';
import type { PlacesSearchObservationPolicy } from '@worker/adapters/out/providers/places-search/registration';
import type { RuntimeReadAttemptSignalBridge } from '@worker/runtime/tool-reads/runtime-read-ports';
import type {
  RuntimeCompositionModelContext,
  RuntimeCompositionValidationContext,
  RuntimePublicResponseDependencies,
} from '@worker/composition/runtime-turn-composition';
import type { RuntimeProductionContextPersistence } from '@worker/runtime/context/runtime-production-context-reference';
import type { ProductionRetentionSource } from '@worker/composition/runtime-production-support';
import type { RuntimeRetentionContext } from '@worker/runtime/retention/runtime-retention';
import type { RuntimeModelGuardModel } from '@worker/runtime/turn-execution/runtime-model-guard';
import type { RuntimeModelTraceSink } from '@worker/runtime/tracing/runtime-model-trace';
import type { RuntimeThinkTurnBuildRequest } from '@worker/runtime/turn-execution/runtime-think-connection';
import type { RuntimeProviderTraceSink } from '@worker/runtime/tracing/runtime-provider-trace';

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
  /** Retention inherited from the history bodies in `modelContext`. */
  readonly historyRetention?: readonly RetentionMetadata[];
  readonly validationContext: RuntimeCompositionValidationContext;
  readonly ids: Pick<IdPort, 'nextCallId' | 'nextResponseId'>;
  readonly hashes: CommitHashPort;
  readonly publicResponse?: RuntimePublicResponseDependencies;
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
