import { parseSavedReferencePath } from '@ima/contracts';
import { createMonotonicAssistantResponseClock } from '@mobile/services/assistant-response-clock';
import type { SavedPlaceRecord, SqliteStore } from '@mobile/services/sqlite/types';
import type { ServerSavedPlaceRef } from '@mobile/services/saved-places/saved-place-types';

export type SavedPlaceListItem = {
  /** Local identity is only used to connect a row to the injected SQLite store. */
  readonly localSavedEntryId: SavedPlaceRecord['localSavedEntryId'];
  /** The only provider-derived identity exposed by this list boundary. */
  readonly serverSavedPlaceRef: ServerSavedPlaceRef;
  /** Null means the saved reference needs a server refresh before it can be named. */
  readonly name: string | null;
  readonly area: string | null;
  readonly savedAt: string;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly retentionUntil: string | null;
  readonly deletionScheduledAt: string | null;
  readonly restoreMode: 'full' | 'reference_only';
  readonly needsRefetch: boolean;
};

export type SavedPlaceListResult =
  | { readonly status: 'available'; readonly items: readonly SavedPlaceListItem[] }
  | {
      readonly status: 'unavailable';
      readonly reason: 'storage_unavailable' | 'clock_unavailable';
    };

export type SavedPlaceListService = {
  readonly list: () => SavedPlaceListResult;
};

export type SavedPlaceListServiceOptions = {
  readonly sqlite?: Pick<SqliteStore, 'listSavedPlaces'>;
  readonly now?: () => string;
};

const unavailable = (
  reason: 'storage_unavailable' | 'clock_unavailable',
): SavedPlaceListResult => ({ status: 'unavailable', reason });

const timestamp = (value: string): number => Date.parse(value);

const reached = (deadline: string | null, nowMilliseconds: number): boolean =>
  deadline !== null && timestamp(deadline) <= nowMilliseconds;

const isDisplayExpired = (place: SavedPlaceRecord, nowMilliseconds: number): boolean => {
  // A reference-only saved place survives the thread's session window. Its provider payload is
  // already absent, so only explicit display/retention deletion deadlines can hide the row.
  const deadlines =
    place.restoreMode === 'full'
      ? [
          place.sessionExpiresAt,
          place.displayUntil,
          place.retentionUntil,
          place.deletionScheduledAt,
        ]
      : [place.displayUntil, place.retentionUntil, place.deletionScheduledAt];
  if (!Number.isFinite(timestamp(place.sessionExpiresAt))) return true;
  if (deadlines.some((deadline) => deadline !== null && !Number.isFinite(timestamp(deadline)))) {
    return true;
  }
  return deadlines.some((deadline) => reached(deadline, nowMilliseconds));
};

const serverReferenceFor = (value: ServerSavedPlaceRef | null): ServerSavedPlaceRef | null => {
  if (value === null) return null;
  return parseSavedReferencePath({ savedPlaceRef: value }).success ? value : null;
};

const listItemFor = (
  place: SavedPlaceRecord,
  nowMilliseconds: number,
): SavedPlaceListItem | null => {
  if (!place.starred || place.restoreMode === 'unavailable') return null;
  const serverSavedPlaceRef = serverReferenceFor(place.serverSavedPlaceRef);
  if (serverSavedPlaceRef === null || isDisplayExpired(place, nowMilliseconds)) return null;

  if (place.restoreMode === 'full' && (place.name === null || place.area === null)) {
    return null;
  }

  return {
    localSavedEntryId: place.localSavedEntryId,
    serverSavedPlaceRef,
    // A non-full row must never re-expose names that the persistence adapter should have
    // redacted. The defensive projection also protects this boundary from a corrupt adapter.
    name: place.restoreMode === 'full' ? place.name : null,
    area: place.restoreMode === 'full' ? place.area : null,
    savedAt: place.savedAt,
    sessionExpiresAt: place.sessionExpiresAt,
    displayUntil: place.displayUntil,
    retentionUntil: place.retentionUntil,
    deletionScheduledAt: place.deletionScheduledAt,
    restoreMode: place.restoreMode,
    needsRefetch: place.needsRefetch,
  };
};

export const createSavedPlaceListService = (
  options: SavedPlaceListServiceOptions = {},
): SavedPlaceListService => {
  const sourceNow = options.now ?? (() => new Date().toISOString());
  let lastRawMilliseconds: number | null = null;
  let clockInvalid = false;
  const now = createMonotonicAssistantResponseClock(() => {
    if (clockInvalid) throw new Error('SAVED_PLACE_INVALID_CLOCK');
    const value = sourceNow();
    const milliseconds = timestamp(value);
    if (
      !Number.isFinite(milliseconds) ||
      (lastRawMilliseconds !== null && milliseconds < lastRawMilliseconds)
    ) {
      clockInvalid = true;
      throw new Error('SAVED_PLACE_INVALID_CLOCK');
    }
    lastRawMilliseconds = milliseconds;
    return value;
  });

  const list = (): SavedPlaceListResult => {
    if (options.sqlite === undefined) return unavailable('storage_unavailable');

    let nowMilliseconds: number;
    try {
      nowMilliseconds = timestamp(now());
    } catch {
      return unavailable('clock_unavailable');
    }
    if (!Number.isFinite(nowMilliseconds)) return unavailable('clock_unavailable');

    try {
      const items = options.sqlite.listSavedPlaces().flatMap((place) => {
        const item = listItemFor(place, nowMilliseconds);
        return item === null ? [] : [item];
      });
      return { status: 'available', items };
    } catch {
      return unavailable('storage_unavailable');
    }
  };

  return { list };
};
