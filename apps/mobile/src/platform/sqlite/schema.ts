import type { SqliteConnection } from '@mobile/platform/sqlite/types';

export const SQLITE_SCHEMA_VERSION = 2;

const schemaSql = `
  CREATE TABLE IF NOT EXISTS thread (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '今夜の検索',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS thread_turn (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('search_submitted', 'recover', 'action')),
    candidate_ref TEXT,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS thread_turn_thread_ts ON thread_turn(thread_id, ts);
  CREATE TABLE IF NOT EXISTS thread_snapshot (
    thread_id TEXT PRIMARY KEY REFERENCES thread(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    restore_mode TEXT NOT NULL CHECK (restore_mode = 'reference_only'),
    session_expires_at TEXT NOT NULL,
    display_until TEXT,
    retention_until TEXT,
    deletion_scheduled_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prefs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    home_station_ref TEXT,
    max_walk_minutes INTEGER CHECK (max_walk_minutes IS NULL OR (max_walk_minutes BETWEEN 1 AND 180)),
    minimum_stay_minutes INTEGER CHECK (
      minimum_stay_minutes IS NULL OR (minimum_stay_minutes BETWEEN 1 AND 180)
    ),
    area_text TEXT,
    budget TEXT CHECK (budget IS NULL OR budget IN ('cheap', 'normal', 'any')),
    station_label TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_place (
    local_saved_entry_id TEXT PRIMARY KEY,
    server_saved_place_ref TEXT UNIQUE,
    name TEXT,
    area TEXT,
    saved_at TEXT NOT NULL,
    starred INTEGER NOT NULL CHECK (starred IN (0, 1)),
    decided_at TEXT,
    session_expires_at TEXT NOT NULL,
    display_until TEXT,
    retention_until TEXT,
    deletion_scheduled_at TEXT,
    restore_mode TEXT NOT NULL CHECK (restore_mode IN ('full', 'reference_only', 'unavailable')),
    needs_refetch INTEGER NOT NULL CHECK (needs_refetch IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS saved_place_starred ON saved_place(starred, saved_at);
  CREATE INDEX IF NOT EXISTS saved_place_decided ON saved_place(decided_at);
  CREATE TABLE IF NOT EXISTS skip_tonight (
    candidate_ref TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
`;

/** Migrations are deliberately SDK-neutral; Expo opens the same schema later. */
export const migrateSqlite = (database: SqliteConnection): void => {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.prepare('PRAGMA user_version').get();
    const version = typeof current?.user_version === 'number' ? current.user_version : 0;
    if (version > SQLITE_SCHEMA_VERSION) throw new Error('SQLITE_UNSUPPORTED_SCHEMA_VERSION');
    if (version === 0) {
      database.exec(schemaSql);
    } else if (version === 1) {
      database.exec('ALTER TABLE prefs ADD COLUMN station_label TEXT');
    } else if (version !== SQLITE_SCHEMA_VERSION) {
      throw new Error('SQLITE_UNSUPPORTED_SCHEMA_VERSION');
    }
    database.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};
