import type {
  RuntimeBudgetDenial,
  RuntimeBudgetResult,
  RuntimeReadReservation,
  RuntimeRouteReservation,
  RuntimeRouteReservationRequest,
} from '@worker/runtime/budget/runtime-budget-types';

const denial = (code: RuntimeBudgetDenial['code'], message: string): RuntimeBudgetDenial => ({
  code,
  message,
});

/** Wraps the common read lease for one route matrix operation. */
export const createRuntimeRouteReservation = (
  request: RuntimeRouteReservationRequest,
  reserveRead: (
    request: RuntimeRouteReservationRequest & { readonly operation: 'walking_route' },
  ) => RuntimeBudgetResult<RuntimeReadReservation>,
  checkAdmission: () => RuntimeBudgetDenial | undefined,
): RuntimeBudgetResult<RuntimeRouteReservation> => {
  const result = reserveRead({ operation: 'walking_route', ...request });
  if (!result.ok) return result;
  let released = false;
  let consumed = false;
  return {
    ok: true,
    value: {
      ...result.value,
      operation: 'walking_route',
      costUnits: request.costUnits,
      providerHttpRequests: request.providerHttpRequests,
      routeElements: request.routeElements,
      release: () => {
        if (released) return;
        released = true;
        result.value.release();
      },
      consume: () => {
        if (released || consumed) {
          return {
            ok: false,
            denial: denial('BUDGET_EXCEEDED', 'route budget lease was already consumed'),
          };
        }
        const blocked = checkAdmission();
        if (blocked !== undefined) return { ok: false, denial: blocked };
        consumed = true;
        return { ok: true, value: undefined };
      },
    },
  };
};
