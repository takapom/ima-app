import type { Preferences } from '@ima/contracts';
import type { SavedPlaceReference } from '@ima/core';
import type {
  SavedReferenceDeleteResult,
  SavedReferenceOperationOptions,
  SavedReferenceReadResult,
  SavedReferenceRegistrationResult,
  SavedReferenceReplayResult,
} from './store';

export type {
  SavedReferenceDeleteResult,
  SavedReferenceOperationOptions,
  SavedReferenceReadResult,
  SavedReferenceRegistrationResult,
  SavedReferenceReplayResult,
};

/** Unsaved owners use revision 0 and prefs null. */
export type OwnerPrefsSnapshot = {
  readonly revision: number;
  readonly prefs: Preferences | null;
};

export type OwnerPrefsReadResult =
  | ({ readonly ok: true } & OwnerPrefsSnapshot)
  | { readonly ok: false; readonly code: 'INVALID_INPUT' };

export type OwnerPrefsPutInput = {
  readonly prefs: Preferences;
  readonly expectedRevision: number;
};

export type OwnerPrefsPutResult =
  | { readonly ok: true; readonly revision: number; readonly replayed: boolean }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'REVISION_CONFLICT' };

export type OwnerDecidedPlace = {
  readonly savedPlaceRef: string;
  readonly decidedAt: string;
};

export type OwnerSavedListResult =
  | {
      readonly ok: true;
      readonly references: readonly SavedPlaceReference[];
      readonly decided: readonly OwnerDecidedPlace[];
    }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' };

export type OwnerDecideInput = {
  readonly provider: string;
  readonly recordRef: string;
  readonly decidedAt: string;
};

export type OwnerDecideResult =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly replayed: boolean;
      readonly reference: SavedPlaceReference;
      readonly decidedAt: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'INVALID_INPUT'
        | 'IDEMPOTENCY_CONFLICT'
        | 'REFERENCE_CONFLICT'
        | 'CORRUPT_ROW'
        | 'INVALID_GENERATED_ID'
        | 'FORBIDDEN'
        | 'OWNER_NOT_INITIALIZED';
    };

export type OwnerRegisterResult =
  | SavedReferenceRegistrationResult
  | { readonly ok: false; readonly code: 'FORBIDDEN' | 'OWNER_NOT_INITIALIZED' };

/**
 * Application/HTTP persistence port. Adapters isolate rows by ownerScopeRef
 * and must not import Cloudflare types.
 */
export type OwnerStore = {
  readonly readPrefs: (ownerScopeRef: string) => Promise<OwnerPrefsReadResult>;
  readonly putPrefs: (
    ownerScopeRef: string,
    input: OwnerPrefsPutInput,
  ) => Promise<OwnerPrefsPutResult>;
  readonly listSaved: (ownerScopeRef: string) => Promise<OwnerSavedListResult>;
  readonly decide: (
    ownerScopeRef: string,
    input: OwnerDecideInput,
    options?: SavedReferenceOperationOptions,
  ) => Promise<OwnerDecideResult>;
  readonly register: (
    ownerScopeRef: string,
    input: { readonly provider: string; readonly recordRef: string },
    options?: SavedReferenceOperationOptions,
  ) => Promise<OwnerRegisterResult>;
  readonly replay: (
    ownerScopeRef: string,
    idempotencyKey: unknown,
    idempotencyFingerprint: unknown,
  ) => Promise<SavedReferenceReplayResult>;
  readonly read: (
    ownerScopeRef: string,
    savedPlaceRef: string,
  ) => Promise<SavedReferenceReadResult>;
  readonly remove: (
    ownerScopeRef: string,
    savedPlaceRef: string,
    options?: SavedReferenceOperationOptions,
  ) => Promise<SavedReferenceDeleteResult>;
};
