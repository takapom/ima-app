import type { CandidateObservationRegistry, PlaceDetailsPort, PlaceSearchPort } from '@ima/core';
import { createHotPepperTransport } from '@api/providers/hot-pepper/transport';
import { createHotPepperSearchAdapter } from '@api/providers/hot-pepper/search-adapter';
import { createHotPepperDetailsAdapter } from '@api/providers/hot-pepper/details-adapter';
import { createPlacesSearchRegistration } from '@api/providers/places-search/registration';
import type { createPlacesSearchContinuation } from '@api/providers/places-search/continuation';
import type { RuntimeProviderTransportObserver } from '@api/providers/telemetry/runtime-provider-trace-contract';
import type { RuntimeBudget } from '@api/runtime/budget/runtime-budget';
import {
  disabledDetailsPort,
  disabledSearchPort,
} from '@api/runtime/composition/runtime-disabled-provider-ports';
import {
  capProductionObservationPolicy,
  defaultProductionObservationPolicy,
  productionClockPort,
  productionSecret,
} from '@api/runtime/composition/runtime-production-support';
import type { ProductionIds } from '@api/runtime/composition/runtime-production-support';
import type { RuntimeProductionProviderAvailability } from '@api/runtime/composition/runtime-production-provider-config';
import type {
  ProductionBuildInput,
  RuntimeProductionOverrides,
} from '@api/runtime/composition/runtime-production-types';

export type RuntimeProductionPlacePorts = {
  readonly search: PlaceSearchPort;
  readonly details: PlaceDetailsPort;
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
  if (!input.providerAvailability.placesEnabled)
    return { search: disabledSearchPort, details: disabledDetailsPort };
  if (input.continuation === undefined) throw new Error('RUNTIME_PRODUCTION_PLACES_UNCONFIGURED');
  const policy = capProductionObservationPolicy(
    input.overrides.observationPolicy ??
      defaultProductionObservationPolicy(input.clock, input.fixedSessionExpiresAt),
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
  const detailsRegistration = createPlacesSearchRegistration({
    registry: input.registry,
    clock: productionClockPort(input.clock),
    observationPolicy: capProductionObservationPolicy(
      input.overrides.detailsObservationPolicy ?? policy,
      input.fixedSessionExpiresAt,
    ),
  });
  // A new provider snapshot supersedes the prior value, including its evaluation time.
  const replacing = (base: typeof registration): typeof registration => ({
    ...base,
    registerObservation: (observation) => {
      const { scope, candidateId, field } = observation;
      input.registry.invalidateObservationReuse(scope, candidateId, field);
      const stored = base.registerObservation(observation);
      if (stored !== undefined)
        input.registry.restoreObservationReuse(scope, candidateId, field, [stored.observationId]);
      return stored;
    },
  });
  const apiKey =
    input.overrides.hotPepperApiKey ?? productionSecret(input.env, 'HOTPEPPER_API_KEY');
  const transport =
    input.overrides.hotPepperTransport ??
    createHotPepperTransport({
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(input.overrides.fetcher === undefined ? {} : { fetcher: input.overrides.fetcher }),
      ...(input.providerTraceObserver === undefined
        ? {}
        : { observer: input.providerTraceObserver }),
    });
  const search = createHotPepperSearchAdapter({
    transport,
    registration: replacing(registration),
    continuation: input.continuation,
    nextSearchId: () => input.ids.nextSearchId(),
    clock: input.clock,
    signalFor: input.build.attemptSignalBridge.signalFor,
  });
  return {
    search: {
      search: async (...args) => {
        const result = await search.search(...args);
        if (result.status === 'ok' || result.status === 'partial') {
          for (const candidate of result.data.candidates)
            input.areaByCandidate.set(candidate.candidateId, result.data.applied.areaDescription);
        }
        return result;
      },
    },
    details: createHotPepperDetailsAdapter({
      transport,
      registry: input.registry,
      registration: replacing(detailsRegistration),
      clock: input.clock,
      areaFor: (id) => input.areaByCandidate.get(id) ?? '検索結果の地域',
      signalFor: input.build.attemptSignalBridge.signalFor,
    }),
  };
};
