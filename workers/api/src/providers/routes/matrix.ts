import * as v from 'valibot';
import type {
  DirectedWalkingRouteLegInput,
  DirectedWalkingRouteResult,
  HarnessContext,
  Issue,
  Result,
  WalkingCoordinates,
} from '@ima/core';
import {
  GoogleRouteMatrixRequestSchema,
  type GoogleRouteMatrixRequest,
  type GoogleRouteWaypoint,
} from './types';
import type { RouteWaypointLookup, RouteWaypointResolution } from './resolver';

export type MatrixGroupKind = 'current_to_candidate' | 'candidate_to_station';

export type MatrixPreflight = {
  readonly result: DirectedWalkingRouteResult;
  readonly warning: Issue;
};

export type MatrixGroupBuildError =
  | {
      readonly status: 'error';
      readonly failure: 'preflight';
      readonly error: Issue;
      readonly preflight: readonly MatrixPreflight[];
    }
  | {
      readonly status: 'error';
      readonly failure: 'invalid';
      readonly error: Issue;
    };

export type MatrixGroup = {
  readonly kind: MatrixGroupKind;
  readonly request: GoogleRouteMatrixRequest;
  readonly legsByPair: ReadonlyMap<string, DirectedWalkingRouteLegInput>;
  readonly preflight: readonly MatrixPreflight[];
};

const issue = (code: Issue['code'], path: string, message: string): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [],
});

const resultError = <T>(error: Issue): Result<T> => ({ status: 'error', error });

const preflightError = (
  error: Issue,
  preflight: readonly MatrixPreflight[],
): MatrixGroupBuildError => ({
  status: 'error',
  failure: 'preflight',
  error,
  preflight,
});

const invalidGroupError = (error: Issue): MatrixGroupBuildError => ({
  status: 'error',
  failure: 'invalid',
  error,
});

type PointResolution = GoogleRouteWaypoint | { readonly status: 'error'; readonly error: Issue };

export const matrixPairKey = (originIndex: number, destinationIndex: number): string =>
  `${originIndex}:${destinationIndex}`;

const sameWaypoint = (left: GoogleRouteWaypoint, right: GoogleRouteWaypoint): boolean => {
  if ('placeId' in left && 'placeId' in right) return left.placeId === right.placeId;
  if ('coordinates' in left && 'coordinates' in right) {
    return (
      left.coordinates.lat === right.coordinates.lat &&
      left.coordinates.lng === right.coordinates.lng
    );
  }
  return false;
};

const resolutionError = (
  resolution: Extract<RouteWaypointResolution, { readonly ok: false }>,
): PointResolution => ({ status: 'error', error: resolution.error });

const preflightFor = (leg: DirectedWalkingRouteLegInput, error: Issue): MatrixPreflight => ({
  result: {
    kind: 'element_error',
    leg: leg.kind,
    originRef: leg.originRef,
    destinationRef:
      leg.kind === 'current_to_candidate' ? leg.destinationCandidateId : leg.destinationStationRef,
    reason: error.code,
  },
  warning: error,
});

const appendPoint = (
  points: Array<{ readonly ref: string } & GoogleRouteWaypoint>,
  indexes: Map<string, number>,
  ref: string,
  waypoint: GoogleRouteWaypoint,
): Result<number> => {
  const existingIndex = indexes.get(ref);
  if (existingIndex !== undefined) {
    const existing = points[existingIndex];
    if (existing === undefined || !sameWaypoint(existing, waypoint)) {
      return resultError(
        issue('INVALID_ARGUMENT', 'legs', 'route reference has conflicting waypoints'),
      );
    }
    return { status: 'ok', data: existingIndex, warnings: [] };
  }
  indexes.set(ref, points.length);
  points.push({ ref, ...waypoint });
  return { status: 'ok', data: points.length - 1, warnings: [] };
};

const pointFor = (resolution: RouteWaypointResolution): PointResolution => {
  if (!resolution.ok) return resolutionError(resolution);
  return resolution.waypoint;
};

/** Builds a provider matrix from Core legs while resolving all non-current endpoints in Worker code. */
export const buildMatrixGroup = (
  kind: MatrixGroupKind,
  legs: readonly DirectedWalkingRouteLegInput[],
  context: HarnessContext,
  lookup: RouteWaypointLookup,
  currentCoordinates?: WalkingCoordinates,
): MatrixGroup | MatrixGroupBuildError => {
  const origins: Array<{ readonly ref: string } & GoogleRouteWaypoint> = [];
  const destinations: Array<{ readonly ref: string } & GoogleRouteWaypoint> = [];
  const originIndexes = new Map<string, number>();
  const destinationIndexes = new Map<string, number>();
  const legsByPair = new Map<string, DirectedWalkingRouteLegInput>();
  const preflight: MatrixPreflight[] = [];

  for (const leg of legs) {
    const originRef = leg.originRef;
    const destinationRef =
      leg.kind === 'current_to_candidate' ? leg.destinationCandidateId : leg.destinationStationRef;
    let resolvedOrigin: RouteWaypointResolution;
    let resolvedDestination: RouteWaypointResolution;
    if (leg.kind === 'current_to_candidate') {
      resolvedOrigin = {
        ok: true,
        waypoint: { coordinates: currentCoordinates ?? leg.originCoordinates },
      };
      resolvedDestination = lookup.resolveCandidateWaypoint(leg.destinationCandidateId, context);
    } else {
      resolvedOrigin = lookup.resolveCandidateWaypoint(leg.originCandidateId, context);
      resolvedDestination = lookup.resolveStationWaypoint(leg.destinationStationRef, context);
    }
    const origin = pointFor(resolvedOrigin);
    if ('status' in origin) {
      preflight.push(preflightFor(leg, origin.error));
      continue;
    }
    const destination = pointFor(resolvedDestination);
    if ('status' in destination) {
      preflight.push(preflightFor(leg, destination.error));
      continue;
    }
    const originIndex = appendPoint(origins, originIndexes, originRef, origin);
    if (originIndex.status === 'error') return invalidGroupError(originIndex.error);
    const destinationIndex = appendPoint(
      destinations,
      destinationIndexes,
      destinationRef,
      destination,
    );
    if (destinationIndex.status === 'error') {
      return invalidGroupError(destinationIndex.error);
    }
    const key = matrixPairKey(originIndex.data, destinationIndex.data);
    if (legsByPair.has(key)) {
      return invalidGroupError(issue('INVALID_ARGUMENT', 'legs', 'duplicate route matrix pair'));
    }
    legsByPair.set(key, leg);
  }

  if (legsByPair.size === 0) {
    const first = preflight[0];
    return preflightError(
      first?.warning ?? issue('MISSING_EVIDENCE', 'legs', 'route waypoints are unavailable'),
      preflight,
    );
  }

  const request = { origins, destinations } satisfies GoogleRouteMatrixRequest;
  if (!v.safeParse(GoogleRouteMatrixRequestSchema, request).success) {
    return invalidGroupError(issue('INVALID_ARGUMENT', 'legs', 'route matrix request is invalid'));
  }
  return { kind, request, legsByPair, preflight };
};
