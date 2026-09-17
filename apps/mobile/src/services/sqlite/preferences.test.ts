import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Preferences } from '@ima/contracts';
import { migrateSqlite, SQLITE_SCHEMA_VERSION } from '@mobile/services/sqlite/schema';
import { createSqliteStore } from '@mobile/services/sqlite/store';
import type {
  LocalSavedEntryId,
  SqliteConnection,
  SqliteValue,
} from '@mobile/services/sqlite/types';

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
  homeStationRef: 'station-ebisu',
  maxWalkMinutes: 20,
  minimumStayMinutes: 30,
  areaText: '恵比寿',
  budget: 'normal',
};

describe('SQLite local station preference', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  const openStore = () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    return {
      database,
      store: createSqliteStore(connectionFor(database), {
        clock: { now: () => '2026-09-11T02:00:00.000Z' },
        nextLocalSavedEntryId: () => asLocal('local-preferences'),
      }),
    };
  };

  it('reads, preserves, and explicitly clears the local station label', () => {
    const { store } = openStore();
    store.savePreferences({ ...basePreferences, stationLabel: '渋谷' });
    expect(store.readPreferences()).toMatchObject({ stationLabel: '渋谷' });

    store.savePreferences({ ...basePreferences, budget: 'cheap' });
    expect(store.readPreferences()).toMatchObject({ stationLabel: '渋谷', budget: 'cheap' });

    store.savePreferences({ ...basePreferences, stationLabel: '' });
    expect(store.readPreferences()).toMatchObject({ stationLabel: null });
  });

  it('rejects a wrong type or a label longer than the existing 160-character text bound', () => {
    const { store } = openStore();
    store.savePreferences({ ...basePreferences, stationLabel: '渋谷' });
    expect(() =>
      store.savePreferences({ ...basePreferences, stationLabel: 'x'.repeat(161) }),
    ).toThrow('SQLITE_INVALID_PREFERENCES');
    expect(() =>
      store.savePreferences({
        ...basePreferences,
        stationLabel: 42 as unknown as string,
      }),
    ).toThrow('SQLITE_INVALID_PREFERENCES');
    expect(store.readPreferences()).toMatchObject({ stationLabel: '渋谷' });
  });

  it('does not inherit a corrupt label but allows explicit clear or repair', () => {
    const { database, store } = openStore();
    store.savePreferences({ ...basePreferences, stationLabel: '渋谷' });
    database.prepare('UPDATE prefs SET station_label = ? WHERE id = 1').run('x'.repeat(161));

    expect(() => store.savePreferences({ ...basePreferences, budget: 'cheap' })).toThrow(
      'SQLITE_INVALID_PREFERENCES',
    );
    expect(store.readPreferences()).toBeNull();

    store.savePreferences({ ...basePreferences, budget: 'cheap', stationLabel: '' });
    expect(store.readPreferences()).toMatchObject({ stationLabel: null, budget: 'cheap' });

    database.prepare('UPDATE prefs SET station_label = ? WHERE id = 1').run('y'.repeat(161));
    store.savePreferences({ ...basePreferences, budget: 'cheap', stationLabel: '新宿' });
    expect(store.readPreferences()).toMatchObject({ stationLabel: '新宿', budget: 'cheap' });
  });

  it('migrates v1 preferences and preserves existing thread and saved rows', () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec(`
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
      CREATE TABLE prefs (
        id INTEGER PRIMARY KEY,
        home_station_ref TEXT,
        max_walk_minutes INTEGER,
        minimum_stay_minutes INTEGER,
        area_text TEXT,
        budget TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE saved_place (local_saved_entry_id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE skip_tonight (candidate_ref TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
      INSERT INTO thread (id, created_at, expires_at)
        VALUES ('thread-before-v2', '2026-09-11T01:00:00.000Z', '2026-09-11T05:00:00.000Z');
      INSERT INTO thread_turn (id, thread_id, kind, candidate_ref, ts)
        VALUES ('turn-before-v2', 'thread-before-v2', 'search_submitted', NULL, '2026-09-11T01:00:00.000Z');
      INSERT INTO saved_place (local_saved_entry_id, name)
        VALUES ('local-before-v2', 'existing row');
      INSERT INTO prefs (id, home_station_ref, max_walk_minutes, minimum_stay_minutes, area_text, budget, updated_at)
        VALUES (1, 'station-ebisu', 20, 30, '恵比寿', 'normal', '2026-09-11T01:00:00.000Z');
      PRAGMA user_version = 1;
    `);

    migrateSqlite(connectionFor(database));

    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    expect(SQLITE_SCHEMA_VERSION).toBe(2);
    expect(
      database
        .prepare('PRAGMA table_info(prefs)')
        .all()
        .some((row) => row.name === 'station_label'),
    ).toBe(true);
    expect(database.prepare('SELECT station_label FROM prefs WHERE id = 1').get()).toEqual({
      station_label: null,
    });
    expect(database.prepare('SELECT id FROM thread').all()).toEqual([{ id: 'thread-before-v2' }]);
    expect(database.prepare('SELECT id FROM thread_turn').all()).toEqual([
      { id: 'turn-before-v2' },
    ]);
    expect(database.prepare('SELECT local_saved_entry_id FROM saved_place').all()).toEqual([
      { local_saved_entry_id: 'local-before-v2' },
    ]);
  });
});
