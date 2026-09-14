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
