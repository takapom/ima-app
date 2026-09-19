import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('SQLite thread history', () => {
  const databases: DatabaseSync[] = [];
  let current = '2026-09-08T04:30:00+09:00';

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    current = '2026-09-08T04:30:00+09:00';
  });

  const openStore = () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    return {
      database,
      store: createSqliteStore(connectionFor(database), {
        clock: { now: () => current },
        nextLocalSavedEntryId: () => asLocal('local-history'),
      }),
    };
  };

  it('returns live rows in descending creation order without response data', () => {
    const { database, store } = openStore();
    store.saveThread({
      id: 'thread-old',
      createdAt: '2026-09-08T03:30:00+09:00',
      expiresAt: '2026-09-08T04:59:00+09:00',
    });
    store.saveThread({
      id: 'thread-new',
      createdAt: '2026-09-08T04:20:00+09:00',
      expiresAt: '2026-09-08T04:59:00+09:00',
    });
    database
      .prepare('INSERT INTO thread (id, created_at, expires_at) VALUES (?, ?, ?)')
      .run('bad/date', 'not-a-date', '2026-09-08T20:00:00.000Z');
    database
      .prepare('INSERT INTO thread (id, created_at, expires_at) VALUES (?, ?, ?)')
      .run('bad/order', '2026-09-07T19:31:00.000Z', '2026-09-07T19:31:00.000Z');
    database
      .prepare('INSERT INTO thread (id, created_at, expires_at) VALUES (?, ?, ?)')
      .run('future-thread', '2026-09-07T19:31:00.000Z', '2026-09-07T19:59:00.000Z');
    database
      .prepare('INSERT INTO thread (id, created_at, expires_at) VALUES (?, ?, ?)')
      .run('expired-thread', '2026-09-07T18:00:00.000Z', '2026-09-07T19:30:00.000Z');

    expect(store.listThreads()).toEqual([
      {
        id: 'thread-new',
        createdAt: '2026-09-07T19:20:00.000Z',
        expiresAt: '2026-09-07T19:59:00.000Z',
      },
      {
        id: 'thread-old',
        createdAt: '2026-09-07T18:30:00.000Z',
        expiresAt: '2026-09-07T19:59:00.000Z',
      },
    ]);
    expect(database.prepare('SELECT * FROM thread').all()).toEqual([
      {
        id: 'thread-old',
        label: '今夜の検索',
        created_at: '2026-09-07T18:30:00.000Z',
        expires_at: '2026-09-07T19:59:00.000Z',
      },
      {
        id: 'thread-new',
        label: '今夜の検索',
        created_at: '2026-09-07T19:20:00.000Z',
        expires_at: '2026-09-07T19:59:00.000Z',
      },
      {
        id: 'bad/date',
        label: '今夜の検索',
        created_at: 'not-a-date',
        expires_at: '2026-09-08T20:00:00.000Z',
      },
      {
        id: 'bad/order',
        label: '今夜の検索',
        created_at: '2026-09-07T19:31:00.000Z',
        expires_at: '2026-09-07T19:31:00.000Z',
      },
      {
        id: 'future-thread',
        label: '今夜の検索',
        created_at: '2026-09-07T19:31:00.000Z',
        expires_at: '2026-09-07T19:59:00.000Z',
      },
    ]);
    expect(Object.keys(database.prepare('SELECT * FROM thread').all()[0] ?? {}).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'label',
    ]);
  });

  it('deletes a thread when its expiry reaches the 05:00 boundary', () => {
    const { database, store } = openStore();
    store.saveThread({
      id: 'thread-boundary',
      createdAt: '2026-09-08T04:00:00+09:00',
      expiresAt: '2026-09-08T05:00:00+09:00',
    });
    current = '2026-09-08T05:00:00+09:00';

    expect(store.listThreads()).toEqual([]);
    expect(database.prepare('SELECT * FROM thread').all()).toEqual([]);
  });
});
