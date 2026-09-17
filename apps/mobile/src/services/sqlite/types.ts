import type { Preferences, RetentionMetadata } from '@ima/contracts';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '@mobile/services/saved-places/saved-place-types';

export type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
} from '@mobile/services/saved-places/saved-place-types';

export type SqliteValue = string | number | null;

export type SqliteStatement = {
  readonly run: (...values: SqliteValue[]) => void;
  readonly get: (...values: SqliteValue[]) => Record<string, unknown> | undefined;
  readonly all: (...values: SqliteValue[]) => readonly Record<string, unknown>[];
};

export type SqliteConnection = {
  readonly exec: (sql: string) => void;
  readonly prepare: (sql: string) => SqliteStatement;
};

export type SqliteClock = {
  readonly now: () => string;
};

export type SqliteStoreOptions = {
  readonly clock: SqliteClock;
  readonly nextLocalSavedEntryId: () => LocalSavedEntryId;
};

export type SavedPlaceInput = {
  readonly localSavedEntryId?: LocalSavedEntryId;
  readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
  readonly referenceRetention: RetentionMetadata | null;
  readonly display: {
    readonly name: string;
    readonly area: string;
    readonly retention: RetentionMetadata;
  } | null;
  readonly savedAt?: string;
};

export type SavedPlaceRecord = {
  readonly localSavedEntryId: LocalSavedEntryId;
  readonly serverSavedPlaceRef: ServerSavedPlaceRef | null;
  readonly name: string | null;
  readonly area: string | null;
  readonly savedAt: string;
  readonly starred: boolean;
  readonly decidedAt: string | null;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly retentionUntil: string | null;
  readonly deletionScheduledAt: string | null;
  readonly restoreMode: 'full' | 'reference_only' | 'unavailable';
  readonly needsRefetch: boolean;
};

export type SavePlaceResult =
  | { readonly status: 'saved'; readonly place: SavedPlaceRecord }
  | { readonly status: 'already_saved'; readonly place: SavedPlaceRecord }
  | { readonly status: 'rejected'; readonly reason: 'retention_denied' | 'invalid_input' };

export type SnapshotInput = {
  readonly threadId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly retentionUntil: string | null;
  readonly deletionScheduledAt: string | null;
  readonly updatedAt?: string;
};

export type SnapshotRecord = {
  readonly threadId: string;
  readonly responseId: string;
  readonly revision: number;
  readonly response: null;
  readonly restoreMode: 'reference_only';
  readonly updatedAt: string;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly retentionUntil: string | null;
  readonly deletionScheduledAt: string | null;
  readonly needsRefetch: boolean;
};

export type ThreadInput = {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
};

export type ThreadTurnInput = {
  readonly id: string;
  readonly threadId: string;
  readonly kind: 'search_submitted' | 'recover' | 'action';
  readonly candidateRef: string | null;
  readonly timestamp?: string;
};

export type ThreadRecord = ThreadInput;

export type ThreadTurnRecord = {
  readonly id: string;
  readonly threadId: string;
  readonly kind: ThreadTurnInput['kind'];
  readonly candidateRef: string | null;
  readonly timestamp: string;
};

/** Local-only input; stationLabel is never sent as a canonical station reference. */
export type SqlitePreferencesInput = Preferences & { readonly stationLabel?: string };

export type SqlitePreferences = Preferences & {
  readonly stationLabel: string | null;
  readonly updatedAt: string;
};

export type SqliteStore = {
  readonly savePlace: (input: SavedPlaceInput) => SavePlaceResult;
  readonly listSavedPlaces: () => readonly SavedPlaceRecord[];
  readonly listTonightDecisions: () => readonly SavedPlaceRecord[];
  readonly setStarred: (localSavedEntryId: LocalSavedEntryId, starred: boolean) => boolean;
  readonly markDecided: (localSavedEntryId: LocalSavedEntryId, decidedAt?: string) => boolean;
  readonly deleteSavedPlace: (localSavedEntryId: LocalSavedEntryId) => boolean;
  readonly saveSkipTonight: (candidateRef: string, expiresAt?: string) => void;
  readonly isSkippedTonight: (candidateRef: string) => boolean;
  readonly saveThread: (input: ThreadInput) => void;
  readonly listThreads: () => readonly ThreadRecord[];
  readonly appendTurn: (input: ThreadTurnInput) => void;
  readonly listTurns: (threadId: string) => readonly ThreadTurnRecord[];
  readonly writeSnapshot: (input: SnapshotInput) => boolean;
  readonly readSnapshot: (threadId: string) => SnapshotRecord | null;
  readonly savePreferences: (preferences: SqlitePreferencesInput) => void;
  readonly readPreferences: () => SqlitePreferences | null;
  readonly cleanupExpired: () => void;
};
