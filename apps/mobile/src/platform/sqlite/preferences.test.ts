import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Preferences } from '@ima/contracts';
import { migrateSqlite, SQLITE_SCHEMA_VERSION } from '@mobile/platform/sqlite/schema';
import { createSqliteStore } from '@mobile/platform/sqlite/store';
import type {
  LocalSavedEntryId,
  SqliteConnection,
  SqliteValue,
} from '@mobile/platform/sqlite/types';

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;

const connectionFor = (database: DatabaseSync): SqliteConnection => ({
  exec: (sql) => database.exec(sql),
  prepare: (sql) => {
    const statement = database.prepare(sql);
    return {
      run: (...values: SqliteValue[]) => statement.run(...values),
      get: (...values: SqliteValue[]) => statement.get(...values),
      all: (...values: SqliteValue[]) =>
        statement.all(...values).map((row) => row as Record<string, unknown>),
    };
  },
});

const basePreferences: Preferences = {
  areaText: '恵比寿',
  budget: 'normal',
};

const legacyTables = (prefsColumns: string): string => `
  CREATE TABLE thread (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '今夜の検索',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE thread_turn (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    candidate_ref TEXT,
    ts TEXT NOT NULL
  );
  CREATE TABLE thread_snapshot (
    thread_id TEXT PRIMARY KEY,
    response_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    restore_mode TEXT NOT NULL,
    session_expires_at TEXT NOT NULL,
    display_until TEXT,
    retention_until TEXT,
    deletion_scheduled_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE prefs (${prefsColumns});
  CREATE TABLE saved_place (local_saved_entry_id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE skip_tonight (candidate_ref TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
  INSERT INTO thread (id, created_at, expires_at)
    VALUES ('thread-before-v3', '2026-09-11T01:00:00.000Z', '2026-09-11T05:00:00.000Z');
  INSERT INTO thread_turn (id, thread_id, kind, candidate_ref, ts)
    VALUES ('turn-before-v3', 'thread-before-v3', 'search_submitted', NULL, '2026-09-11T01:00:00.000Z');
  INSERT INTO saved_place (local_saved_entry_id, name)
    VALUES ('local-before-v3', 'existing row');
`;

describe('SQLite preferences', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  const openDatabase = () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    return database;
  };

  const prefsColumns = (database: DatabaseSync) =>
    database
      .prepare('PRAGMA table_info(prefs)')
      .all()
      .map((row) => row.name);

  const expectOtherRowsKept = (database: DatabaseSync) => {
    expect(database.prepare('SELECT id FROM thread').all()).toEqual([{ id: 'thread-before-v3' }]);
    expect(database.prepare('SELECT id FROM thread_turn').all()).toEqual([
      { id: 'turn-before-v3' },
    ]);
    expect(database.prepare('SELECT local_saved_entry_id FROM saved_place').all()).toEqual([
      { local_saved_entry_id: 'local-before-v3' },
    ]);
  };

  it('saves and reads budget and area text', () => {
    const store = createSqliteStore(connectionFor(openDatabase()), {
      clock: { now: () => '2026-09-11T02:00:00.000Z' },
      nextLocalSavedEntryId: () => asLocal('local-preferences'),
    });
    expect(store.readPreferences()).toBeNull();
    store.savePreferences(basePreferences);
    store.savePreferences({ ...basePreferences, budget: 'cheap' });
    expect(store.readPreferences()).toEqual({
      areaText: '恵比寿',
      budget: 'cheap',
      updatedAt: '2026-09-11T02:00:00.000Z',
    });
  });

  it('drops the v1 walking and last-train columns and keeps the remaining values', () => {
    const database = openDatabase();
    database.exec(`
      ${legacyTables(`
        id INTEGER PRIMARY KEY,
        home_station_ref TEXT,
        max_walk_minutes INTEGER,
        minimum_stay_minutes INTEGER,
        area_text TEXT,
        budget TEXT,
        updated_at TEXT NOT NULL
      `)}
      INSERT INTO prefs (id, home_station_ref, max_walk_minutes, minimum_stay_minutes, area_text, budget, updated_at)
        VALUES (1, 'station-ebisu', 20, 30, '恵比寿', 'normal', '2026-09-11T01:00:00.000Z');
      PRAGMA user_version = 1;
    `);

    migrateSqlite(connectionFor(database));

    expect(SQLITE_SCHEMA_VERSION).toBe(3);
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(prefsColumns(database)).toEqual(['id', 'area_text', 'budget', 'updated_at']);
    expect(database.prepare('SELECT area_text, budget FROM prefs WHERE id = 1').get()).toEqual({
      area_text: '恵比寿',
      budget: 'normal',
    });
    expectOtherRowsKept(database);
  });

  it('drops the v2 station label and checked walking columns', () => {
    const database = openDatabase();
    database.exec(`
      ${legacyTables(`
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
      `)}
      INSERT INTO prefs (id, home_station_ref, max_walk_minutes, minimum_stay_minutes, area_text, budget, station_label, updated_at)
        VALUES (1, 'station-ebisu', 20, 30, NULL, 'cheap', '渋谷', '2026-09-11T01:00:00.000Z');
      PRAGMA user_version = 2;
    `);

    migrateSqlite(connectionFor(database));

    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    expect(prefsColumns(database)).toEqual(['id', 'area_text', 'budget', 'updated_at']);
    expect(database.prepare('SELECT area_text, budget FROM prefs WHERE id = 1').get()).toEqual({
      area_text: null,
      budget: 'cheap',
    });
    expectOtherRowsKept(database);
  });
});
