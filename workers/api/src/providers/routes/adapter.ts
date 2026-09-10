import * as v from 'valibot';
import {
  DirectedWalkingRouteInputSchema,
  HarnessContextSchema,
  IsoTimestampSchema,
  type DirectedWalkingRouteLegInput,
  type DirectedWalkingRoutePort,
  type DirectedWalkingRouteResult,
  type HarnessContext,
  type Issue,
  type Result,
  type WalkingCoordinates,
  type WalkingRoutePort,
  validateWalkingLocation,
} from '@ima/core';
import {
  GoogleRouteMatrixError,
  type GoogleRouteMatrixTransport,
  routeElementCount,
} from './types';
import { normalizeGoogleRouteMatrix, type DirectedRouteMatrixResult } from './normalize';
import type { RuntimeBudgetDenial } from '../../runtime/runtime-budget';
import type { RouteBudgetBoundary, RouteBudgetLease, RouteReadCost } from './budget';
import { createWalkingRoutePortBridge } from './legacy-adapter';
import { buildMatrixGroup, matrixPairKey, type MatrixGroup, type MatrixPreflight } from './matrix';
import type { RouteWaypointLookup } from './resolver';

export { createRuntimeRouteBudgetBoundary, preReservedRouteBudget } from './budget';
export type { RouteBudgetBoundary, RouteBudgetLease, RouteReadCost } from './budget';

export type GoogleWalkingRouteAdapterOptions = {
  readonly transport: GoogleRouteMatrixTransport;
  readonly budget: RouteBudgetBoundary;
  readonly clock: () => string;
  /** Returns the current Harness snapshot so a slow provider cannot outlive its turn context. */
  readonly resolveContext: () => HarnessContext;
  /** Worker resolves candidate and station references to provider waypoints. */
  readonly waypointResolver: RouteWaypointLookup;
  readonly signal?: AbortSignal;
};

type CurrentLocationValidation =
  | { readonly status: 'valid'; readonly coordinates: WalkingCoordinates }
  | { readonly status: 'invalid'; readonly issue: Issue };

const issue = (
  code: Issue['code'],
  path: string | null,
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): Issue => ({
  code,
  path,
  retryable,
  retryAfterMs,
  message,
  missingFields: [],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

const cancelled = <T>(): Result<T> =>
  resultError(issue('CANCELLED', null, 'walking route cancelled'));

const invalidArgument = <T>(message: string): Result<T> =>
  resultError(issue('INVALID_ARGUMENT', null, message));

const issueForBudgetDenial = (denial: RuntimeBudgetDenial): Issue => {
  switch (denial.code) {
    case 'CANCELLED':
      return issue('CANCELLED', null, denial.message);
    case 'STALE_TURN':
      return issue('STALE_TURN', null, denial.message);
    case 'DEADLINE':
      return issue('TIMEOUT', null, denial.message);
    case 'FINAL_RESERVE':
    case 'BUDGET_EXCEEDED':
    case 'PARALLEL_LIMIT':
    case 'COMMITTED':
    case 'RETRY_NOT_ALLOWED':
      return issue('BUDGET_EXCEEDED', null, denial.message);
  }
};

const mapProviderError = (error: GoogleRouteMatrixError): Issue => {
  switch (error.code) {
    case 'CANCELLED':
      return issue('CANCELLED', null, 'walking route cancelled');
    case 'TIMEOUT':
      return issue('TIMEOUT', null, 'walking route provider timed out', true);
    case 'RATE_LIMITED':
      return issue(
        'RATE_LIMITED',
        null,
        'walking route provider was rate limited',
        true,
        error.retryAfterMs,
      );
    case 'INVALID_REQUEST':
      return issue('INVALID_ARGUMENT', null, 'walking route request was rejected');
    case 'MISSING_API_KEY':
      return issue('MISSING_CONTEXT', null, 'walking route provider is not configured');
    case 'SCHEMA_MISMATCH':
      return issue('SCHEMA_MISMATCH', null, 'walking route provider response was invalid');
    case 'UPSTREAM_UNAVAILABLE':
      return issue('UPSTREAM_UNAVAILABLE', null, 'walking route provider was unavailable', true);
  }
};

const warningFor = (
  result: Extract<DirectedRouteMatrixResult, { kind: 'unreachable' | 'element_error' | 'missing' }>,
): Issue => {
  if (result.kind === 'unreachable') {
    return issue('UPSTREAM_UNAVAILABLE', result.destinationRef, 'walking route was not found');
  }
  if (result.kind === 'missing') {
    return issue('MISSING_EVIDENCE', result.destinationRef, 'walking route element was missing');
  }
  return issue('SCHEMA_MISMATCH', result.destinationRef, 'walking route element was invalid');
};

const routeResultFor = (
  group: MatrixGroup,
  normalized: DirectedRouteMatrixResult,
): DirectedWalkingRouteResult | undefined => {
  const leg = group.legsByPair.get(
    matrixPairKey(normalized.originIndex, normalized.destinationIndex),
  );
  if (leg === undefined) return undefined;
  if (normalized.kind !== 'route') {
    return {
      kind: normalized.kind,
      leg: group.kind,
      originRef: normalized.originRef,
      destinationRef: normalized.destinationRef,
      reason: normalized.reason,
    };
  }
  if (leg.kind === 'current_to_candidate') {
    return {
      kind: 'route',
      leg: 'current_to_candidate',
      route: {
        originRef: leg.originRef,
        destinationCandidateId: leg.destinationCandidateId,
        originRevision: leg.originRevision,
        evaluatedAt: normalized.evaluatedAt,
        durationSeconds: normalized.durationSeconds,
        distanceMeters: normalized.distanceMeters,
        warnings: [],
      },
    };
  }
  return {
    kind: 'route',
    leg: 'candidate_to_station',
    route: {
      originCandidateId: leg.originCandidateId,
      originRef: leg.originRef,
      destinationStationRef: leg.destinationStationRef,
      evaluatedAt: normalized.evaluatedAt,
      durationSeconds: normalized.durationSeconds,
      distanceMeters: normalized.distanceMeters,
      warnings: [],
    },
  };
};

const reservationFits = (lease: RouteBudgetLease, cost: RouteReadCost): boolean =>
  lease.costUnits >= cost.costUnits &&
  lease.providerHttpRequests >= cost.providerHttpRequests &&
  lease.routeElements >= cost.routeElements;

const validateCurrentLegs = (
  legs: readonly Extract<DirectedWalkingRouteLegInput, { kind: 'current_to_candidate' }>[],
  location: HarnessContext['location'],
  now: string,
  originCoordinatesOverride?: WalkingCoordinates,
): CurrentLocationValidation => {
  const firstLeg = legs[0];
  if (firstLeg === undefined) {
    return {
      status: 'invalid',
      issue: issue('INVALID_ARGUMENT', 'legs', 'current route leg is missing'),
    };
  }
  let coordinates: WalkingCoordinates | undefined;
  for (const leg of legs) {
    const validated = validateWalkingLocation({
      location,
      now,
      expectedRevision: leg.originRevision,
      originCoordinates: originCoordinatesOverride ?? leg.originCoordinates,
    });
    if (validated.status === 'invalid') return validated;
    coordinates ??= validated.coordinates;
  }
  if (coordinates === undefined) {
    return {
      status: 'invalid',
      issue: issue('LOCATION_REQUIRED', 'location', 'location is required'),
    };
  }
  return { status: 'valid', coordinates };
};

export const createGoogleWalkingRouteAdapter = (
  options: GoogleWalkingRouteAdapterOptions,
): DirectedWalkingRoutePort & WalkingRoutePort => {
  const computeDirected: DirectedWalkingRoutePort['computeDirected'] = async (
    input,
    context,
    execution,
    cancellation,
  ) => {
    const parsedInput = v.safeParse(DirectedWalkingRouteInputSchema, input);
    const parsedContext = v.safeParse(HarnessContextSchema, context);
    if (!parsedInput.success || !parsedContext.success) {
      return invalidArgument('walking route context or input is invalid');
    }
    const liveAtStart = v.safeParse(HarnessContextSchema, options.resolveContext());
    if (!liveAtStart.success) return invalidArgument('walking route live context is invalid');
    if (
      execution.operation !== 'walking_route' ||
      execution.threadId !== context.threadId ||
      execution.turnId !== context.turnId ||
      execution.revision !== context.revision
    ) {
      return resultError(issue('STALE_TURN', null, 'walking route execution context is stale'));
    }
    if (
      liveAtStart.output.threadId !== context.threadId ||
      liveAtStart.output.turnId !== context.turnId ||
      liveAtStart.output.revision !== context.revision
    ) {
      return resultError(issue('STALE_TURN', null, 'walking route context is stale'));
    }
    if (cancellation.isCancelled() || options.signal?.aborted) return cancelled();

    const departureAt = options.clock();
    if (!v.safeParse(IsoTimestampSchema, departureAt).success) {
      return resultError(issue('MISSING_CONTEXT', null, 'route evaluation clock is invalid'));
    }
    const currentLegs = parsedInput.output.legs.filter(
      (leg): leg is Extract<DirectedWalkingRouteLegInput, { kind: 'current_to_candidate' }> =>
        leg.kind === 'current_to_candidate',
    );
    const stationLegs = parsedInput.output.legs.filter(
      (leg): leg is Extract<DirectedWalkingRouteLegInput, { kind: 'candidate_to_station' }> =>
        leg.kind === 'candidate_to_station',
    );
    let currentCoordinates: WalkingCoordinates | undefined;
    if (currentLegs.length > 0) {
      const location = validateCurrentLegs(currentLegs, liveAtStart.output.location, departureAt);
      if (location.status === 'invalid') return resultError(location.issue);
      currentCoordinates = location.coordinates;
    }

    const groups: MatrixGroup[] = [];
    const preflight: MatrixPreflight[] = [];
    if (currentLegs.length > 0) {
      const group = buildMatrixGroup(
        'current_to_candidate',
        currentLegs,
        context,
        options.waypointResolver,
        currentCoordinates,
      );
      if ('status' in group) {
        if (group.failure === 'invalid') return resultError(group.error);
        preflight.push(...group.preflight);
      } else {
        groups.push(group);
      }
    }
    if (stationLegs.length > 0) {
      const group = buildMatrixGroup(
        'candidate_to_station',
        stationLegs,
        context,
        options.waypointResolver,
      );
      if ('status' in group) {
        if (group.failure === 'invalid') return resultError(group.error);
        preflight.push(...group.preflight);
      } else {
        groups.push(group);
      }
    }
    if (groups.length === 0) {
      if (preflight.length === 0) return invalidArgument('at least one route leg is required');
      return {
        status: 'partial',
        data: preflight.map(({ result }) => result),
        warnings: preflight.map(({ warning }) => warning),
      };
    }
    if (cancellation.isCancelled() || options.signal?.aborted) return cancelled();

    const cost: RouteReadCost = {
      providerHttpRequests: groups.length,
      routeElements: groups.reduce((total, group) => total + routeElementCount(group.request), 0),
      costUnits:
        groups.length +
        groups.reduce((total, group) => total + routeElementCount(group.request), 0),
    };
    let ownedLease: RouteBudgetLease | undefined;
    if (options.budget.kind === 'reserve') {
      const reservation = options.budget.reserve(cost);
      if (!reservation.ok) {
        return resultError(issueForBudgetDenial(reservation.denial));
      }
      ownedLease = reservation.value;
      const consumed = ownedLease.consume();
      if (!consumed.ok) {
        ownedLease.release();
        ownedLease = undefined;
        return resultError(issueForBudgetDenial(consumed.denial));
      }
    } else {
      if (!reservationFits(options.budget.lease, cost)) {
        return resultError(
          issue('BUDGET_EXCEEDED', null, 'pre-reserved route budget is insufficient'),
        );
      }
      const consumed = options.budget.lease.consume();
      if (!consumed.ok) {
        return resultError(issueForBudgetDenial(consumed.denial));
      }
    }

    try {
      if (cancellation.isCancelled() || options.signal?.aborted) return cancelled();
      const groupResults = await Promise.all(
        groups.map(async (group) => {
          try {
            const response = await options.transport.compute(group.request, options.signal);
            return { group, response } as const;
          } catch (error: unknown) {
            if (!(error instanceof GoogleRouteMatrixError)) throw error;
            return { group, error } as const;
          }
        }),
      );
      if (cancellation.isCancelled() || options.signal?.aborted) return cancelled();
      const evaluatedAt = options.clock();
      const liveAfterFetch = v.safeParse(HarnessContextSchema, options.resolveContext());
      if (!v.safeParse(IsoTimestampSchema, evaluatedAt).success || !liveAfterFetch.success) {
        return resultError(issue('MISSING_CONTEXT', null, 'route evaluation clock is invalid'));
      }
      if (
        liveAfterFetch.output.threadId !== context.threadId ||
        liveAfterFetch.output.turnId !== context.turnId ||
        liveAfterFetch.output.revision !== context.revision
      ) {
        return resultError(issue('STALE_TURN', null, 'walking route context became stale'));
      }
      if (currentLegs.length > 0) {
        const latestLocation = validateCurrentLegs(
          currentLegs,
          liveAfterFetch.output.location,
          evaluatedAt,
          currentCoordinates,
        );
        if (latestLocation.status === 'invalid') return resultError(latestLocation.issue);
      }
      const data: DirectedWalkingRouteResult[] = [
        ...preflight.map(({ result }) => result),
        ...groups.flatMap((group) => group.preflight.map(({ result }) => result)),
      ];
      const warnings: Issue[] = [
        ...preflight.map(({ warning }) => warning),
        ...groups.flatMap((group) => group.preflight.map(({ warning }) => warning)),
      ];
      for (const groupResult of groupResults) {
        if ('error' in groupResult) {
          const groupIssue = mapProviderError(groupResult.error);
          if (groupIssue.code === 'CANCELLED') return resultError(groupIssue);
          warnings.push(groupIssue);
          for (const leg of groupResult.group.legsByPair.values()) {
            data.push({
              kind: 'element_error',
              leg: leg.kind,
              originRef: leg.originRef,
              destinationRef:
                leg.kind === 'current_to_candidate'
                  ? leg.destinationCandidateId
                  : leg.destinationStationRef,
              reason: groupResult.error.code,
            });
          }
          continue;
        }
        let normalizedResults: readonly DirectedRouteMatrixResult[];
        try {
          normalizedResults = normalizeGoogleRouteMatrix(
            groupResult.group.request,
            groupResult.response,
            evaluatedAt,
          );
        } catch (error: unknown) {
          if (!(error instanceof GoogleRouteMatrixError)) throw error;
          const normalizeIssue = mapProviderError(error);
          warnings.push(normalizeIssue);
          for (const leg of groupResult.group.legsByPair.values()) {
            data.push({
              kind: 'element_error',
              leg: leg.kind,
              originRef: leg.originRef,
              destinationRef:
                leg.kind === 'current_to_candidate'
                  ? leg.destinationCandidateId
                  : leg.destinationStationRef,
              reason: error.code,
            });
          }
          continue;
        }
        for (const normalized of normalizedResults) {
          const mapped = routeResultFor(groupResult.group, normalized);
          if (mapped === undefined) continue;
          data.push(mapped);
          if (normalized.kind !== 'route') warnings.push(warningFor(normalized));
        }
      }
      return warnings.length === 0
        ? { status: 'ok', data, warnings: [] }
        : { status: 'partial', data, warnings };
    } catch (error: unknown) {
      if (error instanceof GoogleRouteMatrixError) return resultError(mapProviderError(error));
      throw error;
    } finally {
      ownedLease?.release();
    }
  };

  return {
    computeDirected,
    ...createWalkingRoutePortBridge(
      { computeDirected },
      options.waypointResolver.resolveCandidateWaypoint,
    ),
  };
};
