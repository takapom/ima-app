import * as v from 'valibot';
import {
  GoogleRouteMatrixError,
  GoogleRouteMatrixRequestSchema,
  type GoogleRouteMatrixElement,
  type GoogleRouteMatrixRequest,
} from './types';
import { parseGoogleRouteMatrixResponse } from './transport';

const timestamp = v.pipe(v.string(), v.isoTimestamp());
const MAX_ROUTE_DISTANCE_METERS = 2_147_483_647;

export type DirectedRouteMatrixResult =
  | {
      readonly kind: 'route';
      readonly originIndex: number;
      readonly destinationIndex: number;
      readonly originRef: string;
      readonly destinationRef: string;
      readonly evaluatedAt: string;
      readonly durationSeconds: number;
      readonly distanceMeters: number;
    }
  | {
      readonly kind: 'unreachable';
      readonly originIndex: number;
      readonly destinationIndex: number;
      readonly originRef: string;
      readonly destinationRef: string;
      readonly evaluatedAt: string;
      readonly reason: 'ROUTE_NOT_FOUND';
    }
  | {
      readonly kind: 'element_error';
      readonly originIndex: number;
      readonly destinationIndex: number;
      readonly originRef: string;
      readonly destinationRef: string;
      readonly evaluatedAt: string;
      readonly reason: 'PROVIDER_ERROR' | 'INVALID_ELEMENT';
      readonly providerStatusCode: number | null;
    }
  | {
      readonly kind: 'missing';
      readonly originIndex: number;
      readonly destinationIndex: number;
      readonly originRef: string;
      readonly destinationRef: string;
      readonly evaluatedAt: string;
      readonly reason: 'MISSING_ELEMENT';
    };

const pairKey = (originIndex: number, destinationIndex: number): string =>
  `${originIndex}:${destinationIndex}`;

const parseDurationSeconds = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?s$/.exec(value);
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = match[2] === undefined ? 0 : Number(`0.${match[2]}`);
  const seconds = whole + fraction;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER) return null;
  // Core consumes safe integer seconds; ceiling prevents a fractional route from being understated.
  const roundedSeconds = Math.ceil(seconds);
  return Number.isSafeInteger(roundedSeconds) ? roundedSeconds : null;
};

const parseDistanceMeters = (value: number | undefined): number | null => {
  if (value === undefined) return 0;
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_ROUTE_DISTANCE_METERS
    ? value
    : null;
};

const common = (
  request: GoogleRouteMatrixRequest,
  originIndex: number,
  destinationIndex: number,
  evaluatedAt: string,
) => {
  const origin = request.origins[originIndex];
  const destination = request.destinations[destinationIndex];
  if (origin === undefined || destination === undefined) {
    throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
  }
  return {
    originIndex,
    destinationIndex,
    originRef: origin.ref,
    destinationRef: destination.ref,
    evaluatedAt,
  } as const;
};

const normalizeElement = (
  request: GoogleRouteMatrixRequest,
  element: GoogleRouteMatrixElement,
  evaluatedAt: string,
): DirectedRouteMatrixResult => {
  const base = common(request, element.originIndex, element.destinationIndex, evaluatedAt);
  if (element.parseError === 'INVALID_ELEMENT') {
    return {
      kind: 'element_error',
      ...base,
      reason: 'INVALID_ELEMENT',
      providerStatusCode: null,
    };
  }
  const providerStatusCode = element.status?.code ?? 0;
  if (providerStatusCode !== 0) {
    return { kind: 'element_error', ...base, reason: 'PROVIDER_ERROR', providerStatusCode };
  }
  if (element.condition === 'ROUTE_NOT_FOUND') {
    return { kind: 'unreachable', ...base, reason: 'ROUTE_NOT_FOUND' };
  }
  if (element.condition !== 'ROUTE_EXISTS') {
    return {
      kind: 'element_error',
      ...base,
      reason: 'INVALID_ELEMENT',
      providerStatusCode: null,
    };
  }

  const durationSeconds = parseDurationSeconds(element.duration);
  const distanceMeters = parseDistanceMeters(element.distanceMeters);
  if (durationSeconds === null || distanceMeters === null) {
    return {
      kind: 'element_error',
      ...base,
      reason: 'INVALID_ELEMENT',
      providerStatusCode: null,
    };
  }
  return { kind: 'route', ...base, durationSeconds, distanceMeters };
};

/**
 * Rebuilds every requested directed pair from provider indexes. Provider response order is ignored.
 * Duration remains whole seconds here; display-minute rounding belongs to the Core/public adapter.
 */
export const normalizeGoogleRouteMatrix = (
  request: GoogleRouteMatrixRequest,
  response: readonly GoogleRouteMatrixElement[],
  evaluatedAt: string,
): readonly DirectedRouteMatrixResult[] => {
  if (!v.safeParse(GoogleRouteMatrixRequestSchema, request).success) {
    throw new GoogleRouteMatrixError('INVALID_REQUEST');
  }
  if (!v.safeParse(timestamp, evaluatedAt).success) {
    throw new GoogleRouteMatrixError('INVALID_REQUEST');
  }
  const seen = new Set<string>();
  const byPair = new Map<string, GoogleRouteMatrixElement>();
  for (const element of response) {
    if (
      !Number.isSafeInteger(element.originIndex) ||
      element.originIndex < 0 ||
      !Number.isSafeInteger(element.destinationIndex) ||
      element.destinationIndex < 0
    ) {
      throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
    }
    if (
      element.originIndex >= request.origins.length ||
      element.destinationIndex >= request.destinations.length
    ) {
      throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
    }
    const key = pairKey(element.originIndex, element.destinationIndex);
    if (seen.has(key)) throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
    seen.add(key);
    byPair.set(key, element);
  }

  const results: DirectedRouteMatrixResult[] = [];
  for (let originIndex = 0; originIndex < request.origins.length; originIndex += 1) {
    for (
      let destinationIndex = 0;
      destinationIndex < request.destinations.length;
      destinationIndex += 1
    ) {
      const element = byPair.get(pairKey(originIndex, destinationIndex));
      if (element === undefined) {
        results.push({
          kind: 'missing',
          ...common(request, originIndex, destinationIndex, evaluatedAt),
          reason: 'MISSING_ELEMENT',
        });
      } else {
        results.push(normalizeElement(request, element, evaluatedAt));
      }
    }
  }
  return results;
};

/** Convenience boundary for fixtures or callers that still hold an untyped JSON response. */
export const normalizeRawGoogleRouteMatrix = (
  request: GoogleRouteMatrixRequest,
  response: unknown,
  evaluatedAt: string,
): readonly DirectedRouteMatrixResult[] =>
  normalizeGoogleRouteMatrix(request, parseGoogleRouteMatrixResponse(response), evaluatedAt);
