import { parseRetentionMetadata, type RetentionMetadata } from '@ima/contracts';
import {
  canPersistOwnerScopedReference,
  projectRetention,
  sessionExpiryAt,
  sessionWindowStartAt,
} from '@mobile/services/sqlite/retention';
import { currentIso } from '@mobile/services/sqlite/expiration';
import type {
  LocalSavedEntryId,
  SavedPlaceInput,
  SavedPlaceRecord,
  SavePlaceResult,
  SqliteConnection,
  SqliteStore,
  SqliteStoreOptions,
} from '@mobile/services/sqlite/types';
import { iso, opaqueId, readSavedPlace, text } from '@mobile/services/sqlite/rows';

type SavedPlaceStore = Pick<
  SqliteStore,
  | 'savePlace'
  | 'listSavedPlaces'
  | 'listTonightDecisions'
  | 'setStarred'
  | 'markDecided'
  | 'deleteSavedPlace'
>;

const optionalTimestamp = (value: string | undefined, fallback: string): string | null =>
  value === undefined ? fallback : iso(value);

const projectionForDisplay = (
  display: NonNullable<SavedPlaceInput['display']>,
  retention: RetentionMetadata,
  now: string,
): {
  readonly name: string;
  readonly area: string;
  readonly retention: RetentionMetadata;
} | null => {
  const projection = projectRetention(retention, now);
  if (!projection.canPersistPayload) return null;
  return { name: display.name, area: display.area, retention };
};

const savedReference = (row: Record<string, unknown> | undefined): string | null =>
  text(row ?? {}, 'server_saved_place_ref');

export const createSavedPlaceStore = (
  database: SqliteConnection,
  options: Pick<SqliteStoreOptions, 'clock' | 'nextLocalSavedEntryId'>,
  cleanupExpired: () => void,
): SavedPlaceStore => {
  const redactInvalidSavedRows = (rows: readonly Record<string, unknown>[]): void => {
    for (const row of rows) {
      const localId = text(row, 'local_saved_entry_id');
      const decoded = readSavedPlace(row);
      if (localId === null || decoded !== null) continue;
      database
        .prepare(
          `UPDATE saved_place
           SET name = NULL, area = NULL,
               restore_mode = CASE WHEN server_saved_place_ref IS NULL THEN 'unavailable' ELSE 'reference_only' END,
               needs_refetch = 1
           WHERE local_saved_entry_id = ?`,
        )
        .run(localId);
    }
  };

  const allSavedPlaces = (): readonly SavedPlaceRecord[] => {
    cleanupExpired();
    const rows = database.prepare('SELECT * FROM saved_place ORDER BY saved_at DESC').all();
    redactInvalidSavedRows(rows);
    return rows
      .map((row) => readSavedPlace(row))
      .filter((place): place is SavedPlaceRecord => place !== null);
  };

  const savePlace = (input: SavedPlaceInput): SavePlaceResult => {
    const now = currentIso(options.clock);
    if (
      (input.localSavedEntryId !== undefined && opaqueId(input.localSavedEntryId) === null) ||
      (input.serverSavedPlaceRef !== null && opaqueId(input.serverSavedPlaceRef) === null)
    ) {
      return { status: 'rejected', reason: 'invalid_input' };
    }
    const referenceRetention =
      input.referenceRetention === null ? null : parseRetentionMetadata(input.referenceRetention);
    const displayRetention =
      input.display === null ? null : parseRetentionMetadata(input.display.retention);
    if (
      (input.referenceRetention !== null && referenceRetention === null) ||
      (input.display !== null && displayRetention === null)
    ) {
      return { status: 'rejected', reason: 'invalid_input' };
    }
    const display =
      input.display === null || displayRetention === null
        ? null
        : projectionForDisplay(input.display, displayRetention, now);
    const referenceAllowed =
      input.serverSavedPlaceRef === null ||
      (referenceRetention !== null && canPersistOwnerScopedReference(referenceRetention));
    if (!referenceAllowed || (display === null && input.serverSavedPlaceRef === null)) {
      return { status: 'rejected', reason: 'retention_denied' };
    }
    cleanupExpired();

    const reference = input.serverSavedPlaceRef;
    const existingByLocal =
      input.localSavedEntryId === undefined
        ? undefined
        : database
            .prepare(
              'SELECT local_saved_entry_id, server_saved_place_ref FROM saved_place WHERE local_saved_entry_id = ?',
            )
            .get(input.localSavedEntryId);
    const existingByReference =
      reference === null
        ? undefined
        : database
            .prepare(
              'SELECT local_saved_entry_id, server_saved_place_ref FROM saved_place WHERE server_saved_place_ref = ?',
            )
            .get(reference);
    const existingLocalId = text(existingByLocal ?? {}, 'local_saved_entry_id');
    const referencedLocalId = text(existingByReference ?? {}, 'local_saved_entry_id');
    if (
      (existingLocalId !== null &&
        referencedLocalId !== null &&
        existingLocalId !== referencedLocalId) ||
      (input.localSavedEntryId !== undefined &&
        referencedLocalId !== null &&
        input.localSavedEntryId !== referencedLocalId)
    ) {
      return { status: 'rejected', reason: 'invalid_input' };
    }
    const existing = existingByLocal ?? existingByReference;
    const storedReference = savedReference(existing);
    if (existing !== undefined && storedReference !== null && reference !== storedReference) {
      return { status: 'rejected', reason: 'invalid_input' };
    }
    const localSavedEntryId =
      existingLocalId ??
      referencedLocalId ??
      input.localSavedEntryId ??
      options.nextLocalSavedEntryId();
    if (opaqueId(localSavedEntryId) === null) {
      return { status: 'rejected', reason: 'invalid_input' };
    }
    const savedAt = optionalTimestamp(input.savedAt, now);
    if (savedAt === null) return { status: 'rejected', reason: 'invalid_input' };
    const sourceRetention = display?.retention ?? referenceRetention;
    const sessionExpiresAt = iso(sourceRetention?.sessionExpiresAt ?? sessionExpiryAt(now));
    if (sessionExpiresAt === null) return { status: 'rejected', reason: 'invalid_input' };
    const displayUntil = iso(display?.retention.displayUntil ?? null);
    const retentionUntil = iso(display?.retention.retentionUntil ?? null);
    const deletionScheduledAt = iso(display?.retention.deletionScheduledAt ?? null);
    const restoreMode = display === null ? 'reference_only' : 'full';
    const needsRefetch = display === null;
    if (existing !== undefined) {
      database
        .prepare(
          `UPDATE saved_place
           SET server_saved_place_ref = ?, name = ?, area = ?, saved_at = ?, starred = 1,
               session_expires_at = ?, display_until = ?, retention_until = ?,
               deletion_scheduled_at = ?, restore_mode = ?, needs_refetch = ?
           WHERE local_saved_entry_id = ?`,
        )
        .run(
          reference,
          display?.name ?? null,
          display?.area ?? null,
          savedAt,
          sessionExpiresAt,
          displayUntil,
          retentionUntil,
          deletionScheduledAt,
          restoreMode,
          needsRefetch ? 1 : 0,
          localSavedEntryId,
        );
      const place = database
        .prepare('SELECT * FROM saved_place WHERE local_saved_entry_id = ?')
        .get(localSavedEntryId);
      const decoded = place === undefined ? null : readSavedPlace(place);
      return decoded === null
        ? { status: 'rejected', reason: 'invalid_input' }
        : { status: 'already_saved', place: decoded };
    }
    database
      .prepare(
        `INSERT INTO saved_place (
          local_saved_entry_id, server_saved_place_ref, name, area, saved_at, starred, decided_at,
          session_expires_at, display_until, retention_until, deletion_scheduled_at, restore_mode, needs_refetch
        ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        localSavedEntryId,
        reference,
        display?.name ?? null,
        display?.area ?? null,
        savedAt,
        sessionExpiresAt,
        displayUntil,
        retentionUntil,
        deletionScheduledAt,
        restoreMode,
        needsRefetch ? 1 : 0,
      );
    const place = database
      .prepare('SELECT * FROM saved_place WHERE local_saved_entry_id = ?')
      .get(localSavedEntryId);
    const decoded = place === undefined ? null : readSavedPlace(place);
    return decoded === null
      ? { status: 'rejected', reason: 'invalid_input' }
      : { status: 'saved', place: decoded };
  };

  const listSavedPlaces = (): readonly SavedPlaceRecord[] =>
    allSavedPlaces().filter((place) => place.starred);

  const listTonightDecisions = (): readonly SavedPlaceRecord[] => {
    const now = currentIso(options.clock);
    const start = Date.parse(sessionWindowStartAt(now));
    const current = Date.parse(now);
    return allSavedPlaces().filter((place) => {
      const decided = place.decidedAt === null ? NaN : Date.parse(place.decidedAt);
      return Number.isFinite(decided) && decided >= start && decided <= current;
    });
  };

  const setStarred = (localSavedEntryId: LocalSavedEntryId, starred: boolean): boolean => {
    if (opaqueId(localSavedEntryId) === null) return false;
    const existing = database
      .prepare('SELECT local_saved_entry_id FROM saved_place WHERE local_saved_entry_id = ?')
      .get(localSavedEntryId);
    if (existing === undefined) return false;
    database
      .prepare('UPDATE saved_place SET starred = ? WHERE local_saved_entry_id = ?')
      .run(starred ? 1 : 0, localSavedEntryId);
    return true;
  };

  const markDecided = (
    localSavedEntryId: LocalSavedEntryId,
    decidedAt = currentIso(options.clock),
  ): boolean => {
    if (opaqueId(localSavedEntryId) === null) return false;
    const canonical = iso(decidedAt);
    if (canonical === null) return false;
    const existing = database
      .prepare('SELECT local_saved_entry_id FROM saved_place WHERE local_saved_entry_id = ?')
      .get(localSavedEntryId);
    if (existing === undefined) {
      database
        .prepare(
          `INSERT INTO saved_place (
            local_saved_entry_id, server_saved_place_ref, name, area, saved_at, starred, decided_at,
            session_expires_at, display_until, retention_until, deletion_scheduled_at, restore_mode, needs_refetch
          ) VALUES (?, NULL, NULL, NULL, ?, 0, ?, ?, NULL, NULL, NULL, 'unavailable', 1)`,
        )
        .run(localSavedEntryId, canonical, canonical, sessionExpiryAt(canonical));
      return true;
    }
    database
      .prepare('UPDATE saved_place SET decided_at = ? WHERE local_saved_entry_id = ?')
      .run(canonical, localSavedEntryId);
    return true;
  };

  const deleteSavedPlace = (localSavedEntryId: LocalSavedEntryId): boolean => {
    if (opaqueId(localSavedEntryId) === null) return false;
    const existing = database
      .prepare('SELECT local_saved_entry_id FROM saved_place WHERE local_saved_entry_id = ?')
      .get(localSavedEntryId);
    if (existing === undefined) return false;
    database
      .prepare('DELETE FROM saved_place WHERE local_saved_entry_id = ?')
      .run(localSavedEntryId);
    return true;
  };

  return {
    savePlace,
    listSavedPlaces,
    listTonightDecisions,
    setStarred,
    markDecided,
    deleteSavedPlace,
  };
};
