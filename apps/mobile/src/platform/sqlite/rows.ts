import type {
  LocalSavedEntryId,
  SavedPlaceRecord,
  SnapshotRecord,
  SqlitePreferences,
} from '@mobile/platform/sqlite/types';

export const text = (row: Record<string, unknown>, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const number = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export const boolean = (row: Record<string, unknown>, key: string): boolean | null => {
  const value = number(row, key);
  return value === null || (value !== 0 && value !== 1) ? null : value === 1;
};

export const iso = (value: string | null): string | null => {
  if (value === null || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
};

export const opaqueId = (value: string | null): string | null =>
  value !== null && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) ? value : null;

export const readSavedPlace = (row: Record<string, unknown>): SavedPlaceRecord | null => {
  const localSavedEntryId = text(row, 'local_saved_entry_id');
  const rawServerSavedPlaceRef = row.server_saved_place_ref;
  const serverSavedPlaceRef =
    typeof rawServerSavedPlaceRef === 'string' && rawServerSavedPlaceRef.length > 0
      ? rawServerSavedPlaceRef
      : null;
  const serverSavedPlaceRefValid =
    rawServerSavedPlaceRef === null ||
    rawServerSavedPlaceRef === undefined ||
    (typeof rawServerSavedPlaceRef === 'string' && opaqueId(rawServerSavedPlaceRef) !== null);
  const savedAt = iso(text(row, 'saved_at'));
  const sessionExpiresAt = iso(text(row, 'session_expires_at'));
  const starred = boolean(row, 'starred');
  const needsRefetch = boolean(row, 'needs_refetch');
  const restoreMode = text(row, 'restore_mode');
  const name = text(row, 'name');
  const area = text(row, 'area');
  const rawDisplayUntil = text(row, 'display_until');
  const rawRetentionUntil = text(row, 'retention_until');
  const rawDeletionScheduledAt = text(row, 'deletion_scheduled_at');
  const rawDecidedAt = text(row, 'decided_at');
  const displayUntil = iso(rawDisplayUntil);
  const retentionUntil = iso(rawRetentionUntil);
  const deletionScheduledAt = iso(rawDeletionScheduledAt);
  const decidedAt = iso(rawDecidedAt);
  if (
    opaqueId(localSavedEntryId) === null ||
    !serverSavedPlaceRefValid ||
    savedAt === null ||
    sessionExpiresAt === null ||
    starred === null ||
    needsRefetch === null ||
    (restoreMode !== 'full' && restoreMode !== 'reference_only' && restoreMode !== 'unavailable') ||
    (rawDisplayUntil !== null && displayUntil === null) ||
    (rawRetentionUntil !== null && retentionUntil === null) ||
    (rawDeletionScheduledAt !== null && deletionScheduledAt === null) ||
    (rawDecidedAt !== null && decidedAt === null) ||
    (restoreMode === 'full' &&
      (name === null ||
        area === null ||
        retentionUntil === null ||
        deletionScheduledAt === null)) ||
    (restoreMode !== 'full' && (name !== null || area !== null))
  ) {
    return null;
  }
  return {
    localSavedEntryId: localSavedEntryId as LocalSavedEntryId,
    serverSavedPlaceRef: serverSavedPlaceRef as SavedPlaceRecord['serverSavedPlaceRef'],
    name,
    area,
    savedAt,
    starred,
    decidedAt,
    sessionExpiresAt,
    displayUntil,
    retentionUntil,
    deletionScheduledAt,
    restoreMode,
    needsRefetch,
  };
};

export const readSnapshot = (row: Record<string, unknown>): SnapshotRecord | null => {
  const threadId = text(row, 'thread_id');
  const responseId = text(row, 'response_id');
  const validThreadId = opaqueId(threadId);
  const validResponseId = opaqueId(responseId);
  const revision = number(row, 'revision');
  const updatedAt = iso(text(row, 'updated_at'));
  const sessionExpiresAt = iso(text(row, 'session_expires_at'));
  const restoreMode = text(row, 'restore_mode');
  const rawDisplayUntil = text(row, 'display_until');
  const rawRetentionUntil = text(row, 'retention_until');
  const rawDeletionScheduledAt = text(row, 'deletion_scheduled_at');
  const displayUntil = iso(rawDisplayUntil);
  const retentionUntil = iso(rawRetentionUntil);
  const deletionScheduledAt = iso(rawDeletionScheduledAt);
  if (
    validThreadId === null ||
    validResponseId === null ||
    revision === null ||
    !Number.isSafeInteger(revision) ||
    updatedAt === null ||
    sessionExpiresAt === null ||
    (rawDisplayUntil !== null && displayUntil === null) ||
    (rawRetentionUntil !== null && retentionUntil === null) ||
    (rawDeletionScheduledAt !== null && deletionScheduledAt === null) ||
    restoreMode !== 'reference_only'
  ) {
    return null;
  }
  return {
    threadId: validThreadId,
    responseId: validResponseId,
    revision,
    response: null,
    restoreMode,
    updatedAt,
    sessionExpiresAt,
    displayUntil,
    retentionUntil,
    deletionScheduledAt,
    needsRefetch: true,
  };
};

export const readPreferences = (
  row: Record<string, unknown>,
  updatedAt: string,
): SqlitePreferences | null => {
  const areaText = row.area_text;
  const budget = row.budget;
  if (
    (areaText !== null && areaText !== undefined && typeof areaText !== 'string') ||
    (budget !== null &&
      budget !== undefined &&
      budget !== 'cheap' &&
      budget !== 'normal' &&
      budget !== 'any')
  ) {
    return null;
  }
  return {
    areaText: typeof areaText === 'string' ? areaText : null,
    budget: budget === 'cheap' || budget === 'normal' || budget === 'any' ? budget : null,
    updatedAt,
  };
};
