import type { CandidateObservationRegistryPort } from '@worker/application/ports/registry';
import type { GetPlaceDetailsInput } from '@worker/application/ports/operations';
import type { HarnessContext } from '@worker/application/ports/context';
import {
  isHotPepperDetailField,
  hotPepperObservationContext,
} from '@worker/adapters/out/providers/hot-pepper/place-observations';
import { productionScopeFor } from '@worker/composition/runtime-production-support';
import type {
  RuntimeReadCost,
  RuntimeReadCostRequest,
} from '@worker/runtime/tool-reads/runtime-read-ports';

const detailsProviderCost = (
  input: GetPlaceDetailsInput,
  context: HarnessContext,
  registry: CandidateObservationRegistryPort,
): number => {
  let requests = 0;
  const scope = productionScopeFor(context);
  const observationContext = hotPepperObservationContext(context);
  for (const request of input.requests) {
    let needsProvider = false;
    try {
      const candidate = registry.readCandidate(scope, request.candidateId);
      if (candidate === undefined || candidate.excluded || candidate.provider !== 'hotpepper') {
        continue;
      }
      for (const field of request.fields) {
        if (!isHotPepperDetailField(field)) continue;
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
): RuntimeReadCost => {
  const providerRequests =
    request.operation === 'search_places'
      ? 1
      : detailsProviderCost(request.input, request.context, registry);
  return {
    costUnits: providerRequests,
    providerHttpRequests: providerRequests,
  };
};
