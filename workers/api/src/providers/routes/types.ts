import * as v from 'valibot';

export const GOOGLE_ROUTE_MATRIX_ENDPOINT =
  'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

/** A bounded mask keeps the provider response and billed work limited to route facts. */
export const GOOGLE_ROUTE_MATRIX_FIELD_MASK =
  'originIndex,destinationIndex,status,condition,distanceMeters,duration';

export const GOOGLE_ROUTE_MATRIX_MAX_ELEMENTS = 625;

const id = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);
const coordinate = v.strictObject({
  lat: v.pipe(v.number(), v.finite(), v.minValue(-90), v.maxValue(90)),
  lng: v.pipe(v.number(), v.finite(), v.minValue(-180), v.maxValue(180)),
});

/** Google Place IDs stay inside the Worker provider boundary. */
export const GooglePlaceIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.regex(/^[A-Za-z0-9_-]+$/u),
);
export type GooglePlaceId = v.InferOutput<typeof GooglePlaceIdSchema>;

export type GoogleRouteWaypoint =
  | { readonly coordinates: { readonly lat: number; readonly lng: number } }
  | { readonly placeId: GooglePlaceId };

export const RouteMatrixPointSchema = v.union([
  v.strictObject({ ref: id, coordinates: coordinate }),
  v.strictObject({ ref: id, placeId: GooglePlaceIdSchema }),
]);

export type RouteMatrixPoint = v.InferOutput<typeof RouteMatrixPointSchema>;

export const GoogleRouteMatrixRequestSchema = v.pipe(
  v.strictObject({
    origins: v.pipe(v.array(RouteMatrixPointSchema), v.minLength(1), v.maxLength(625)),
    destinations: v.pipe(v.array(RouteMatrixPointSchema), v.minLength(1), v.maxLength(625)),
    departureTime: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  }),
  v.check(
    (request) =>
      request.origins.length * request.destinations.length <= GOOGLE_ROUTE_MATRIX_MAX_ELEMENTS,
    'route matrix exceeds the provider element limit',
  ),
  v.check(
    (request) =>
      [...request.origins, ...request.destinations].filter((point) => 'placeId' in point).length <=
      50,
    'route matrix has too many place-id waypoints',
  ),
  v.check(
    (request) => new Set(request.origins.map((point) => point.ref)).size === request.origins.length,
    'route matrix origin references must be unique',
  ),
  v.check(
    (request) =>
      new Set(request.destinations.map((point) => point.ref)).size === request.destinations.length,
    'route matrix destination references must be unique',
  ),
);

export type GoogleRouteMatrixRequest = v.InferOutput<typeof GoogleRouteMatrixRequestSchema>;

export type GoogleRouteMatrixElementCondition =
  'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND' | 'ROUTE_MATRIX_ELEMENT_CONDITION_UNSPECIFIED';

export type GoogleRouteMatrixElementStatus = {
  readonly code?: number;
};

/** Raw fields selected by GOOGLE_ROUTE_MATRIX_FIELD_MASK; default-valued fields may be absent. */
export type GoogleRouteMatrixElement = {
  readonly originIndex: number;
  readonly destinationIndex: number;
  readonly status?: GoogleRouteMatrixElementStatus;
  readonly condition?: GoogleRouteMatrixElementCondition;
  readonly distanceMeters?: number;
  readonly duration?: string;
  /** Set only when a pair-indexed element has a malformed field; other pairs remain usable. */
  readonly parseError?: 'INVALID_ELEMENT';
};

export type GoogleRouteMatrixResponse = readonly GoogleRouteMatrixElement[];

export type GoogleRouteMatrixFailureCode =
  | 'MISSING_API_KEY'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'SCHEMA_MISMATCH';

export type GoogleRouteMatrixErrorOptions = {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
};

/** Provider failures are typed and never carry upstream response text. */
export class GoogleRouteMatrixError extends Error {
  readonly code: GoogleRouteMatrixFailureCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(code: GoogleRouteMatrixFailureCode, options: GoogleRouteMatrixErrorOptions = {}) {
    super(`Google Route Matrix failed: ${code}`);
    this.name = 'GoogleRouteMatrixError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export type GoogleRouteMatrixTransportOptions = {
  /** The key is read from a Worker secret by the composition owner. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
};

export interface GoogleRouteMatrixTransport {
  compute(
    request: GoogleRouteMatrixRequest,
    signal?: AbortSignal,
  ): Promise<GoogleRouteMatrixResponse>;
}

/** The caller reserves one provider request and this exact number of route elements before compute. */
export const routeElementCount = (request: GoogleRouteMatrixRequest): number =>
  request.origins.length * request.destinations.length;
