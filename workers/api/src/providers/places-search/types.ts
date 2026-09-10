export const GOOGLE_TEXT_SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/** The mask is deliberately explicit: wildcard fields can increase cost and leak data. */
export const GOOGLE_TEXT_SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.primaryType,' +
  'places.businessStatus,places.currentOpeningHours,places.priceLevel,' +
  'places.timeZone,places.googleMapsUri,places.attributions,nextPageToken';

export type GoogleLocationBias = {
  readonly circle: {
    readonly center: {
      readonly latitude: number;
      readonly longitude: number;
    };
    readonly radius: number;
  };
};

export type GoogleTextSearchRequest = {
  readonly textQuery: string;
  readonly openNow: boolean;
  readonly pageSize: number;
  readonly pageToken?: string;
  readonly locationBias?: GoogleLocationBias;
};

export type GoogleTextSearchPage = {
  /** Items remain unknown until the shared M12 wire normalizer validates each field. */
  readonly places: readonly unknown[];
  readonly nextPageToken: string | null;
};

export type GoogleTextSearchFailureCode =
  | 'MISSING_API_KEY'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'SCHEMA_MISMATCH';

export type GoogleTextSearchErrorOptions = {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
};

/** Typed failures keep provider details out of Core results and public responses. */
export class GoogleTextSearchError extends Error {
  readonly code: GoogleTextSearchFailureCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(code: GoogleTextSearchFailureCode, options: GoogleTextSearchErrorOptions = {}) {
    super(`Google Text Search failed: ${code}`);
    this.name = 'GoogleTextSearchError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export type PlacesSearchArea =
  | {
      readonly kind: 'current_location';
      readonly radiusMeters: number;
    }
  | {
      readonly kind: 'named_area';
      readonly name: string;
    };

/** All fields are bound when a cursor is issued; only the provider token stays server-side. */
export type PlacesSearchCursorBinding = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly query: string;
  readonly area: PlacesSearchArea;
  readonly openNow: boolean;
  readonly limit: number;
  readonly excludeCandidateIds: readonly string[];
  readonly locationRevision: number;
};

export type PlacesSearchCursorState = PlacesSearchCursorBinding & {
  readonly providerPageToken: string;
};

export type PlacesSearchCursorFailureCode = 'INVALID_CURSOR' | 'CURSOR_EXPIRED';

export type PlacesSearchCursorResolution =
  | { readonly ok: true; readonly providerPageToken: string }
  | { readonly ok: false; readonly code: PlacesSearchCursorFailureCode };
