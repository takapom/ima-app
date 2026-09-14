import type {
  CandidateObservationRegistryPort,
  CapabilitySnapshot,
  HarnessContext,
} from '@ima/core';
import type { RuntimePublicResponseDependencies } from '../turn-execution/runtime-turn-composition';
import { productionScopeFor } from './runtime-production-support';

export const isConfiguredSecret = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0;

export type RuntimeProductionProviderAvailability = { readonly placesEnabled: boolean };

export const capabilitiesWithProviders = (
  base: CapabilitySnapshot,
  availability: RuntimeProductionProviderAvailability,
): CapabilitySnapshot => ({
  ...base,
  version: 'hotpepper-v1',
  detailFields: availability.placesEnabled
    ? ['identity', 'opening_hours', 'price', 'facilities', 'photos']
    : [],
  walkingRoute: false,
  lastTrain: false,
});

export const cardEvidenceResolver =
  (
    registry: Pick<CandidateObservationRegistryPort, 'readObservation'>,
    context: HarnessContext,
  ): NonNullable<RuntimePublicResponseDependencies['resolveCardEvidence']> =>
  (candidateId, evidenceId) => {
    const observation = registry.readObservation(productionScopeFor(context), evidenceId);
    if (observation === undefined || observation.candidateId !== candidateId) return undefined;
    const field = observation.field;
    if (
      field !== 'identity' &&
      field !== 'opening_hours' &&
      field !== 'price' &&
      field !== 'facilities' &&
      field !== 'photos'
    )
      return undefined;
    return {
      observationId: observation.observationId,
      candidateId,
      field,
      sources: observation.sources,
      retention: observation.retention,
    };
  };
