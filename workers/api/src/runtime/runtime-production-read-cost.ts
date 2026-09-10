import type {
  CandidateObservationRegistryPort,
  GetPlaceDetailsInput,
  HarnessContext,
} from '@ima/core';
import {
  isSupportedField,
  observationContextFor,
} from '../providers/places-details/adapter-support';
import type { SavedReferenceDetailsHandoff } from '../providers/places-details/handoff';
import { productionScopeFor } from './runtime-production-support';
import type { RuntimeReadCost, RuntimeReadCostRequest } from './runtime-read-ports';

const detailsProviderCost = (
  input: GetPlaceDetailsInput,
  context: HarnessContext,
  registry: CandidateObservationRegistryPort,
  originRefFor?: (context: HarnessContext) => string | undefined,
  savedReferenceHandoff?: Pick<SavedReferenceDetailsHandoff, 'coverageForCandidate'>,
): number => {
  let requests = 0;
  const scope = productionScopeFor(context);
  const observationContext = observationContextFor(context, originRefFor?.(context) ?? null);
  for (const request of input.requests) {
    let needsProvider = false;
    try {
      const candidate = registry.readCandidate(scope, request.candidateId);
      if (candidate === undefined || candidate.excluded || candidate.provider !== 'google_places') {
        continue;
      }
      const savedCoverage = savedReferenceHandoff?.coverageForCandidate({
        candidateId: request.candidateId,
        scope,
        turnId: context.turnId,
        revision: context.revision,
        fields: request.fields.filter(isSupportedField),
      });
      if (savedCoverage === 'covered') continue;
      for (const field of request.fields) {
        if (!isSupportedField(field)) continue;
        if (input.freshness === 'reuse_valid') {
          const reused = registry.evaluateObservationReuse({
            scope,
            candidateId: request.candidateId,
            field,
            context: observationContext,
          });
          if (reused.status === 'reusable') continue;
        }
        needsProvider = true;
        break;
      }
    } catch {
      // A registry failure must reserve conservatively; it never undercharges an external read.
      needsProvider = true;
    }
    if (needsProvider) requests += 1;
  }
  return requests;
};

export const resolveRuntimeProductionReadCost = (
  request: RuntimeReadCostRequest,
  registry: CandidateObservationRegistryPort,
  originRefFor?: (context: HarnessContext) => string | undefined,
  savedReferenceHandoff?: Pick<SavedReferenceDetailsHandoff, 'coverageForCandidate'>,
): RuntimeReadCost => {
  const providerRequests =
    request.operation === 'search_places'
      ? 1
      : detailsProviderCost(
          request.input,
          request.context,
          registry,
          originRefFor,
          savedReferenceHandoff,
        );
  return {
    costUnits: providerRequests,
    providerHttpRequests: providerRequests,
    routeElements: 0,
  };
};
