import type { SavedPlaceReference } from '@core/domain';

export type SavedReferenceIdFactory = {
  readonly nextSavedPlaceRef: () => string;
};

export type SavedReferenceStoreErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_GENERATED_ID'
  | 'REFERENCE_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CORRUPT_ROW';

export type SavedReferenceOperationOptions = {
  readonly idempotencyKey?: unknown;
  /** Server-computed identity of the candidate/revision request; never provider payload. */
  readonly idempotencyFingerprint?: unknown;
};

export type SavedReferenceRegistrationResult =
  | { readonly ok: true; readonly created: boolean; readonly reference: SavedPlaceReference }
  | { readonly ok: false; readonly code: SavedReferenceStoreErrorCode };

export type SavedReferenceReplayResult =
  | { readonly ok: true; readonly found: false }
  | { readonly ok: true; readonly found: true; readonly reference: SavedPlaceReference }
  | {
      readonly ok: false;
      readonly code:
        'INVALID_INPUT' | 'REFERENCE_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'CORRUPT_ROW';
    };

export type SavedReferenceReadResult =
  | { readonly ok: true; readonly reference: SavedPlaceReference | null }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'CORRUPT_ROW' };

export type SavedReferenceDeleteResult =
  | { readonly ok: true; readonly deleted: boolean }
  | {
      readonly ok: false;
      readonly code: 'INVALID_INPUT' | 'IDEMPOTENCY_CONFLICT' | 'CORRUPT_ROW';
    };
