import * as v from 'valibot';
import { LocationRevisionSchema, type LocationRevision } from '../../domain/freshness';
import type { Issue } from '../../domain/issue';
import { IsoTimestampSchema } from '../../domain/primitives';
import { LocationContextSchema, type LocationContext } from '../../ports/context';
import { WalkingCoordinatesSchema, type WalkingCoordinates } from '../../ports/walking-route';

export const WALKING_LOCATION_MAX_AGE_MS = 120_000;
export const WALKING_LOCATION_MAX_ACCURACY_METERS = 100;
export const WALKING_LOCATION_MAX_MOVEMENT_METERS = 100;

export const WalkingLocationPolicyInputSchema = v.strictObject({
  location: LocationContextSchema,
  now: IsoTimestampSchema,
  expectedRevision: LocationRevisionSchema,
  originCoordinates: WalkingCoordinatesSchema,
});
export type WalkingLocationPolicyInput = v.InferOutput<typeof WalkingLocationPolicyInputSchema>;

export type WalkingLocationPolicyResult =
  | {
      readonly status: 'valid';
      readonly coordinates: WalkingCoordinates;
      readonly revision: LocationRevision;
      readonly capturedAt: string;
    }
  | { readonly status: 'invalid'; readonly issue: Issue };

const issueFor = (
  code: Issue['code'],
  message: string,
  missingFields: readonly string[] = [],
): Issue => ({
  code,
  path: 'location',
  retryable: false,
  retryAfterMs: null,
  message,
  missingFields: [...missingFields],
});

const invalid = (code: Issue['code'], message: string, missingFields: readonly string[] = []) => ({
  status: 'invalid' as const,
  issue: issueFor(code, message, missingFields),
});

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Haversine distance is used only for invalidation, never as a route-time estimate. */
export const distanceBetweenWalkingCoordinatesMeters = (
  left: WalkingCoordinates,
  right: WalkingCoordinates,
): number => {
  const latitudeDelta = radians(right.lat - left.lat);
  const longitudeDelta = radians(right.lng - left.lng);
  const leftLatitude = radians(left.lat);
  const rightLatitude = radians(right.lat);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const boundedA = Math.min(1, Math.max(0, a));
  const distance = 6_371_000 * 2 * Math.atan2(Math.sqrt(boundedA), Math.sqrt(1 - boundedA));
  return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
};

const validLocation = (
  location: LocationContext,
  now: string,
  expectedRevision: LocationRevision,
  originCoordinates: WalkingCoordinates,
): WalkingLocationPolicyResult => {
  if (location.status !== 'available') {
    return location.status === 'reduced'
      ? invalid('LOCATION_IMPRECISE', 'location precision is reduced')
      : invalid('LOCATION_REQUIRED', 'a usable current location is required', ['coordinates']);
  }
  if (location.coordinates === null || location.capturedAt === null) {
    return invalid(
      'LOCATION_REQUIRED',
      'current location coordinates and capture time are required',
      ['coordinates', 'capturedAt'],
    );
  }
  if (
    !location.precise ||
    location.accuracyMeters === null ||
    location.accuracyMeters > WALKING_LOCATION_MAX_ACCURACY_METERS
  ) {
    return invalid('LOCATION_IMPRECISE', 'location accuracy must be at most 100 meters');
  }
  const nowMs = Date.parse(now);
  const capturedAtMs = Date.parse(location.capturedAt);
  const ageMs = nowMs - capturedAtMs;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(capturedAtMs) ||
    ageMs < 0 ||
    ageMs > WALKING_LOCATION_MAX_AGE_MS
  ) {
    return invalid(
      'LOCATION_IMPRECISE',
      'location capture is outside the two-minute freshness window',
    );
  }
  if (location.revision !== expectedRevision) {
    return invalid('STALE_TURN', 'location revision no longer matches the route origin', [
      'revision',
    ]);
  }
  if (
    distanceBetweenWalkingCoordinatesMeters(location.coordinates, originCoordinates) >
    WALKING_LOCATION_MAX_MOVEMENT_METERS
  ) {
    return invalid('LOCATION_IMPRECISE', 'location moved more than 100 meters since route capture');
  }
  return {
    status: 'valid',
    coordinates: location.coordinates,
    revision: location.revision,
    capturedAt: location.capturedAt,
  };
};

export const validateWalkingLocation = (input: unknown): WalkingLocationPolicyResult => {
  const parsed = v.safeParse(WalkingLocationPolicyInputSchema, input);
  if (!parsed.success) return invalid('LOCATION_REQUIRED', 'walking location context is invalid');
  return validLocation(
    parsed.output.location,
    parsed.output.now,
    parsed.output.expectedRevision,
    parsed.output.originCoordinates,
  );
};
