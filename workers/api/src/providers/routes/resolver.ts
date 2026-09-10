import * as v from 'valibot';
import type { CandidateObservationRegistryPort, HarnessContext, Issue } from '@ima/core';
import { GooglePlaceIdSchema, type GooglePlaceId, type GoogleRouteWaypoint } from './types';

export type RouteWaypointResolution =
  | { readonly ok: true; readonly waypoint: GoogleRouteWaypoint }
  | { readonly ok: false; readonly error: Issue };

export type RouteWaypointResolver = (
  reference: string,
  context: HarnessContext,
) => RouteWaypointResolution;

export type RouteWaypointLookup = {
  readonly resolveCandidateWaypoint: RouteWaypointResolver;
  readonly resolveStationWaypoint: RouteWaypointResolver;
};

const issue = (
  code: Issue['code'],
  path: string,
  message: string,
  missingFields: readonly string[] = [],
): Issue => ({
  code,
  path,
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [...missingFields],
});

const missingCandidate = (_candidateId: string): RouteWaypointResolution => ({
  ok: false,
  error: issue('UNKNOWN_CANDIDATE', 'candidateId', 'candidate is unavailable for routing', [
    'candidateId',
  ]),
});

const placeIdFor = (recordRef: string): GooglePlaceId | undefined => {
  const parsed = v.safeParse(GooglePlaceIdSchema, recordRef);
  return parsed.success ? parsed.output : undefined;
};

const candidateResolver =
  (registry: CandidateObservationRegistryPort): RouteWaypointResolver =>
  (candidateId, context) => {
    const candidate = registry.readCandidate(
      { ownerScopeRef: context.ownerScopeRef, threadId: context.threadId },
      candidateId,
    );
    if (candidate === undefined) return missingCandidate(candidateId);
    if (candidate.excluded) {
      return {
        ok: false,
        error: issue('EXCLUDED_CANDIDATE', 'candidateId', 'candidate is excluded from routing', [
          candidateId,
        ]),
      };
    }
    if (candidate.provider !== 'google_places') {
      return {
        ok: false,
        error: issue(
          'UNSUPPORTED_FIELD',
          'candidateId',
          'candidate provider cannot route this place',
        ),
      };
    }
    const placeId = placeIdFor(candidate.recordRef);
    if (placeId === undefined) {
      return {
        ok: false,
        error: issue('MISSING_EVIDENCE', 'candidateId', 'candidate provider reference is invalid', [
          'recordRef',
        ]),
      };
    }
    return { ok: true, waypoint: { placeId } };
  };

export type RegistryRouteWaypointResolverOptions = {
  readonly registry: CandidateObservationRegistryPort;
  /** M14 owns station identity mapping; an unresolved station remains unavailable. */
  readonly resolveStationWaypoint: RouteWaypointResolver;
};

/** Resolves opaque Core references without exposing provider IDs to Core or model callers. */
export const createRegistryRouteWaypointResolver = (
  options: RegistryRouteWaypointResolverOptions,
): RouteWaypointLookup => ({
  resolveCandidateWaypoint: candidateResolver(options.registry),
  resolveStationWaypoint: options.resolveStationWaypoint,
});

export const unavailableStationWaypoint: RouteWaypointResolver = (_stationRef) => ({
  ok: false,
  error: issue('MISSING_EVIDENCE', 'stationRef', 'station location is unavailable', ['stationRef']),
});
