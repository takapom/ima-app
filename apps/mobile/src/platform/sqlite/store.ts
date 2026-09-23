import { createConversationCache } from '@mobile/platform/sqlite/conversations';
import { createSavedPlaceStore } from '@mobile/platform/sqlite/saved-places';
import { cleanupExpiredRows, currentIso } from '@mobile/platform/sqlite/expiration';
import { migrateSqlite } from '@mobile/platform/sqlite/schema';
import { sessionExpiryAt } from '@mobile/platform/sqlite/retention';
import type {
  SnapshotInput,
  SnapshotRecord,
  SqliteConnection,
  SqlitePreferences,
  SqlitePreferencesInput,
  SqliteStore,
  SqliteStoreOptions,
  ThreadInput,
  ThreadRecord,
  ThreadTurnInput,
  ThreadTurnRecord,
} from '@mobile/platform/sqlite/types';
import {
  iso,
  number,
  opaqueId,
  readPreferences,
  readSnapshot,
  text,
} from '@mobile/platform/sqlite/rows';

const optionalTimestamp = (value: string | undefined, fallback: string): string | null =>
  value === undefined ? fallback : iso(value);

export const createSqliteStore = (
  database: SqliteConnection,
  options: SqliteStoreOptions,
): SqliteStore => {
  migrateSqlite(database);
  const conversations = createConversationCache(database, options.clock);
  const cleanupExpired = (): void => {
    cleanupExpiredRows(database, options);
    conversations.cleanup();
  };
  const savedPlaces = createSavedPlaceStore(database, options, cleanupExpired);
  cleanupExpired();

  const saveSkipTonight = (candidateRef: string, expiresAt?: string): void => {
    const now = currentIso(options.clock);
    const sessionExpiry = iso(sessionExpiryAt(now));
    const suppliedExpiry = expiresAt === undefined ? sessionExpiry : iso(expiresAt);
    if (opaqueId(candidateRef) === null || sessionExpiry === null || suppliedExpiry === null) {
      throw new Error('SQLITE_INVALID_SKIP');
    }
    cleanupExpired();
    const existing = database
      .prepare('SELECT expires_at FROM skip_tonight WHERE candidate_ref = ?')
      .get(candidateRef);
    const existingExpiry = iso(text(existing ?? {}, 'expires_at'));
    const boundedExpiry =
      Date.parse(suppliedExpiry) < Date.parse(sessionExpiry) ? suppliedExpiry : sessionExpiry;
    const storedExpiry =
      existingExpiry !== null && Date.parse(existingExpiry) < Date.parse(boundedExpiry)
        ? existingExpiry
        : boundedExpiry;
    database
      .prepare(
        `INSERT INTO skip_tonight (candidate_ref, expires_at) VALUES (?, ?)
         ON CONFLICT(candidate_ref) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(candidateRef, storedExpiry);
  };

  const isSkippedTonight = (candidateRef: string): boolean => {
    if (opaqueId(candidateRef) === null) return false;
    cleanupExpired();
    return (
      database
        .prepare('SELECT candidate_ref FROM skip_tonight WHERE candidate_ref = ?')
        .get(candidateRef) !== undefined
    );
  };

  const saveThread = (input: ThreadInput): void => {
    const createdAt = iso(input.createdAt);
    const suppliedExpiry = iso(input.expiresAt);
    if (opaqueId(input.id) === null || createdAt === null || suppliedExpiry === null) {
      throw new Error('SQLITE_INVALID_THREAD');
    }
    const computedExpiry = iso(sessionExpiryAt(createdAt));
    if (computedExpiry === null) throw new Error('SQLITE_INVALID_THREAD');
    const storedExpiry =
      Date.parse(suppliedExpiry) < Date.parse(computedExpiry) ? suppliedExpiry : computedExpiry;
    database
      .prepare(
        `INSERT INTO thread (id, created_at, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(input.id, createdAt, storedExpiry);
  };

  const listThreads = (): readonly ThreadRecord[] => {
    cleanupExpired();
    const now = currentIso(options.clock);
    const nowMilliseconds = Date.parse(now);
    return database
      .prepare('SELECT id, created_at, expires_at FROM thread ORDER BY created_at DESC, id DESC')
      .all()
      .flatMap((row) => {
        const id = opaqueId(text(row, 'id'));
        const createdAt = iso(text(row, 'created_at'));
        const expiresAt = iso(text(row, 'expires_at'));
        const createdMilliseconds = createdAt === null ? Number.NaN : Date.parse(createdAt);
        const expiresMilliseconds = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
        if (
          id === null ||
          createdAt === null ||
          expiresAt === null ||
          !Number.isFinite(nowMilliseconds) ||
          !Number.isFinite(createdMilliseconds) ||
          !Number.isFinite(expiresMilliseconds) ||
          createdMilliseconds > nowMilliseconds ||
          createdMilliseconds >= expiresMilliseconds ||
          expiresMilliseconds <= nowMilliseconds
        ) {
          return [];
        }
        return [{ id, createdAt, expiresAt }];
      });
  };

  const appendTurn = (input: ThreadTurnInput): void => {
    const timestamp = optionalTimestamp(input.timestamp, currentIso(options.clock));
    if (
      opaqueId(input.id) === null ||
      opaqueId(input.threadId) === null ||
      (input.candidateRef !== null && opaqueId(input.candidateRef) === null) ||
      timestamp === null
    ) {
      throw new Error('SQLITE_INVALID_TURN');
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO thread_turn (id, thread_id, kind, candidate_ref, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.threadId, input.kind, input.candidateRef, timestamp);
  };

  const listTurns = (threadId: string): readonly ThreadTurnRecord[] => {
    if (opaqueId(threadId) === null) return [];
    cleanupExpired();
    return database
      .prepare(
        'SELECT id, thread_id, kind, candidate_ref, ts FROM thread_turn WHERE thread_id = ? ORDER BY ts, id',
      )
      .all(threadId)
      .flatMap((row) => {
        const id = opaqueId(text(row, 'id'));
        const storedThreadId = opaqueId(text(row, 'thread_id'));
        const kind = text(row, 'kind');
        const candidateRef = text(row, 'candidate_ref');
        const timestamp = iso(text(row, 'ts'));
        if (
          id === null ||
          storedThreadId === null ||
          storedThreadId !== threadId ||
          (candidateRef !== null && opaqueId(candidateRef) === null) ||
          timestamp === null ||
          (kind !== 'search_submitted' && kind !== 'recover' && kind !== 'action')
        ) {
          return [];
        }
        return [{ id, threadId, kind, candidateRef, timestamp }];
      });
  };

  const writeSnapshot = (input: SnapshotInput): boolean => {
    if (opaqueId(input.threadId) === null || opaqueId(input.responseId) === null) return false;
    const sessionExpiresAt = iso(input.sessionExpiresAt);
    const displayUntil = iso(input.displayUntil);
    const retentionUntil = iso(input.retentionUntil);
    const deletionScheduledAt = iso(input.deletionScheduledAt);
    const updatedAt = iso(input.updatedAt ?? currentIso(options.clock));
    if (
      input.revision < 1 ||
      !Number.isSafeInteger(input.revision) ||
      sessionExpiresAt === null ||
      updatedAt === null ||
      (input.displayUntil !== null && displayUntil === null) ||
      (input.retentionUntil !== null && retentionUntil === null) ||
      (input.deletionScheduledAt !== null && deletionScheduledAt === null)
    ) {
      return false;
    }
    const current = database
      .prepare('SELECT revision, response_id FROM thread_snapshot WHERE thread_id = ?')
      .get(input.threadId);
    const currentRevision = current === undefined ? null : number(current, 'revision');
    if (currentRevision !== null && currentRevision > input.revision) return false;
    if (currentRevision === input.revision) {
      return text(current ?? {}, 'response_id') === input.responseId;
    }
    database
      .prepare(
        `INSERT INTO thread_snapshot (
          thread_id, response_id, revision, restore_mode,
          session_expires_at, display_until, retention_until, deletion_scheduled_at, updated_at
        ) VALUES (?, ?, ?, 'reference_only', ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          response_id = excluded.response_id,
          revision = excluded.revision,
          restore_mode = 'reference_only',
          session_expires_at = excluded.session_expires_at,
          display_until = excluded.display_until,
          retention_until = excluded.retention_until,
          deletion_scheduled_at = excluded.deletion_scheduled_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.threadId,
        input.responseId,
        input.revision,
        sessionExpiresAt,
        displayUntil,
        retentionUntil,
        deletionScheduledAt,
        updatedAt,
      );
    return true;
  };

  const readSnapshotForThread = (threadId: string): SnapshotRecord | null => {
    if (opaqueId(threadId) === null) return null;
    cleanupExpired();
    const row = database.prepare('SELECT * FROM thread_snapshot WHERE thread_id = ?').get(threadId);
    return row === undefined ? null : readSnapshot(row);
  };

  const savePreferences = (preferences: SqlitePreferencesInput): void => {
    database
      .prepare(
        `INSERT INTO prefs (id, area_text, budget, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          area_text = excluded.area_text,
          budget = excluded.budget,
          updated_at = excluded.updated_at`,
      )
      .run(preferences.areaText, preferences.budget, currentIso(options.clock));
  };

  const readPreferencesForStore = (): SqlitePreferences | null => {
    const row = database.prepare('SELECT * FROM prefs WHERE id = 1').get();
    if (row === undefined) return null;
    const updatedAt = iso(text(row, 'updated_at'));
    return updatedAt === null ? null : readPreferences(row, updatedAt);
  };

  return {
    conversations,
    ...savedPlaces,
    saveSkipTonight,
    isSkippedTonight,
    saveThread,
    listThreads,
    appendTurn,
    listTurns,
    writeSnapshot,
    readSnapshot: readSnapshotForThread,
    savePreferences,
    readPreferences: readPreferencesForStore,
    cleanupExpired,
  };
};
