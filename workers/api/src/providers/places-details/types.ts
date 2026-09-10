import * as v from 'valibot';
import type { DetailField } from '@ima/core';
import type { RuntimeProviderTransportObserver } from '../telemetry/runtime-provider-trace-contract';

export const GOOGLE_PLACE_DETAILS_ENDPOINT = 'https://places.googleapis.com/v1/places';

/** Details supplied directly by Google Places. Other Core fields have separate providers. */
export const GOOGLE_PLACE_DETAILS_FIELDS = [
  'identity',
  'opening_hours',
  'price',
  'photos',
  'contact',
] as const satisfies readonly DetailField[];

export type GooglePlaceDetailsField = (typeof GOOGLE_PLACE_DETAILS_FIELDS)[number];

export const GooglePlaceDetailsFieldSchema = v.picklist(GOOGLE_PLACE_DETAILS_FIELDS);

const isProviderPlaceId = (value: string): boolean => /^[A-Za-z0-9_-]+$/u.test(value);

export const GooglePlaceDetailsRequestSchema = v.strictObject({
  /** This is the provider id, not a public candidateId or a resource path. */
  placeId: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(512),
    v.check(isProviderPlaceId, 'provider place id has an invalid shape'),
  ),
  fields: v.pipe(
    v.array(GooglePlaceDetailsFieldSchema),
    v.minLength(1),
    v.maxLength(GOOGLE_PLACE_DETAILS_FIELDS.length),
    v.check((fields) => new Set(fields).size === fields.length, 'duplicate details field'),
  ),
});
export type GooglePlaceDetailsRequest = v.InferOutput<typeof GooglePlaceDetailsRequestSchema>;

/** The body is intentionally unknown until each requested field is normalized independently. */
export type GooglePlaceDetailsResponse = {
  readonly placeId: string;
  readonly fields: readonly GooglePlaceDetailsField[];
  readonly body: unknown;
};

export type GooglePlaceDetailsTransportOptions = {
  /** The composition owner reads this from the Worker secret binding. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  /** Optional Worker-owned observer; called only immediately before a real fetch starts. */
  readonly observer?: RuntimeProviderTransportObserver;
};

export interface GooglePlaceDetailsTransport {
  read(
    request: GooglePlaceDetailsRequest,
    signal?: AbortSignal,
  ): Promise<GooglePlaceDetailsResponse>;
}

export type GooglePlaceDetailsFailureCode =
  | 'MISSING_API_KEY'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'SCHEMA_MISMATCH';

export type GooglePlaceDetailsErrorOptions = {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
};

/** Typed failures exclude upstream response text and credentials from callers. */
export class GooglePlaceDetailsError extends Error {
  readonly code: GooglePlaceDetailsFailureCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(code: GooglePlaceDetailsFailureCode, options: GooglePlaceDetailsErrorOptions = {}) {
    super(`Google Place Details failed: ${code}`);
    this.name = 'GooglePlaceDetailsError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

const fieldMaskParts: Record<GooglePlaceDetailsField, readonly string[]> = {
  identity: [
    'id',
    'displayName',
    'formattedAddress',
    'primaryType',
    'businessStatus',
    'googleMapsUri',
    'movedPlace',
    'movedPlaceId',
    'attributions',
  ],
  opening_hours: [
    'id',
    'currentOpeningHours',
    'regularOpeningHours',
    'timeZone',
    'googleMapsUri',
    'attributions',
  ],
  price: ['id', 'priceLevel', 'priceRange', 'googleMapsUri', 'attributions'],
  photos: ['id', 'photos', 'googleMapsUri', 'attributions'],
  contact: [
    'id',
    'googleMapsUri',
    'websiteUri',
    'nationalPhoneNumber',
    'internationalPhoneNumber',
    'attributions',
  ],
};

/** Returns a stable, explicit mask; wildcard and unsupported Core fields are impossible here. */
export const googlePlaceDetailsFieldMask = (fields: readonly GooglePlaceDetailsField[]): string => {
  const paths = new Set<string>();
  for (const field of GOOGLE_PLACE_DETAILS_FIELDS) {
    if (!fields.includes(field)) continue;
    for (const path of fieldMaskParts[field]) paths.add(path);
  }
  return [...paths].join(',');
};
