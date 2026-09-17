import type {
  RuntimeBudget,
  RuntimeBudgetResult,
  RuntimeRouteReservation,
} from '@api/runtime/budget/runtime-budget';

export type RouteReadCost = {
  readonly costUnits: number;
  readonly providerHttpRequests: number;
  readonly routeElements: number;
};

export type RouteBudgetLease = RuntimeRouteReservation;

export type RouteBudgetBoundary =
  | {
      readonly kind: 'reserve';
      readonly reserve: (cost: RouteReadCost) => RuntimeBudgetResult<RouteBudgetLease>;
    }
  | {
      readonly kind: 'pre_reserved';
      readonly lease: RouteBudgetLease;
    };

/** Uses the shared budget counters exactly once for all route matrix groups. */
export const createRuntimeRouteBudgetBoundary = (
  budget: Pick<RuntimeBudget, 'reserveRoute'>,
): RouteBudgetBoundary => ({
  kind: 'reserve',
  reserve: (cost) => {
    const reservation = budget.reserveRoute(cost);
    if (!reservation.ok) return reservation;
    return {
      ok: true,
      value: reservation.value,
    };
  },
});

/** The caller keeps ownership of a reservation made by a larger read composition. */
export const preReservedRouteBudget = (lease: RouteBudgetLease): RouteBudgetBoundary => ({
  kind: 'pre_reserved',
  lease,
});
