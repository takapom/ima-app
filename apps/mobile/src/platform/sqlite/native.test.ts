import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RetentionMetadata } from '@ima/contracts';
import {
  createNativeSqliteAdapter,
  isValidStorageScope,
  type NativeSqliteDatabase,
  type NativeSqliteDriver,
} from '@mobile/platform/sqlite/native';
import type { LocalSavedEntryId, SqliteValue } from '@mobile/platform/sqlite/types';

vi.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('the default Expo driver is not used by injected tests');
  },
}));

type Harness = {
  readonly raw: DatabaseSync;
  readonly database: NativeSqliteDatabase;
  readonly scopes: string[];
  closeCount: number;
  finalized: number;
  transactions: number;
  rollbacks: number;
  failSavedPlaceSelect: boolean;
  failInitialization: boolean;
  closed: boolean;
};

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;

const retention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-08T05:00:00+09:00',
  freshUntil: '2026-09-08T04:50:00+09:00',
  displayUntil: '2026-09-08T05:00:00+09:00',
  retentionUntil: '2026-09-08T05:00:00+09:00',
  deletionScheduledAt: '2026-09-08T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const makeHarness = (scopes: string[], failInitialization = false): Harness => {
  const raw = new DatabaseSync(':memory:');
  const harnessDetails = {
    raw,
    scopes,
    closeCount: 0,
    finalized: 0,
    transactions: 0,
    rollbacks: 0,
    failSavedPlaceSelect: false,
    failInitialization,
    closed: false,
  };
  const database: NativeSqliteDatabase = {
    closeSync: () => {
      harnessDetails.closeCount += 1;
      if (!harnessDetails.closed) {
        harnessDetails.closed = true;
        raw.close();
      }
    },
    execSync: (source) => {
      if (
        harnessDetails.failInitialization &&
        source.includes('CREATE TABLE IF NOT EXISTS thread')
      ) {
        throw new Error('injected initialization failure');
      }
      raw.exec(source);
    },
    prepareSync: (source) => {
      if (
        harnessDetails.failSavedPlaceSelect &&
        source.startsWith('SELECT * FROM saved_place WHERE local_saved_entry_id')
      ) {
        throw new Error('injected operation failure');
      }
      const statement = raw.prepare(source);
      const isQuery = /^\s*(SELECT|PRAGMA)\b/i.test(source);
      return {
        executeSync: <T>(...values: SqliteValue[]) => {
          const rows = isQuery
            ? statement.all(...values).map((row) => row as Record<string, unknown>)
            : [];
          if (!isQuery) statement.run(...values);
          return {
            getFirstSync: (): T | null => {
              const first = rows[0];
              return first === undefined ? null : (first as unknown as T);
            },
            getAllSync: (): T[] => rows as unknown as T[],
          };
        },
        finalizeSync: () => {
          harnessDetails.finalized += 1;
        },
      };
    },
    withTransactionSync: (task) => {
      harnessDetails.transactions += 1;
      raw.exec('BEGIN');
      try {
        task();
        raw.exec('COMMIT');
      } catch (error) {
        harnessDetails.rollbacks += 1;
        raw.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return Object.assign(harnessDetails, { database });
};

describe('native SQLite adapter', () => {
  const harnesses: Harness[] = [];
  const scopes: string[] = [];
  let id = 0;

  afterEach(() => {
    for (const harness of harnesses.splice(0)) {
      if (!harness.closed) harness.raw.close();
    }
    scopes.splice(0);
    id = 0;
  });

  const driverFor = (failFirstInitialization = false): NativeSqliteDriver => ({
    openDatabaseSync: (scope) => {
      scopes.push(scope);
      const harness = makeHarness(scopes, failFirstInitialization && id === 0);
      id += 1;
      harnesses.push(harness);
      return harness.database;
    },
  });

  const optionsFor = (driver: NativeSqliteDriver, storageScope = 'owner-a-dev') => ({
    storageScope,
    driver,
    clock: { now: () => '2026-09-08T04:30:00+09:00' },
    nextLocalSavedEntryId: () => asLocal('local-native'),
  });

  it('translates sync statements, serializes operations, and supports close/reopen', () => {
    const adapter = createNativeSqliteAdapter(optionsFor(driverFor()));
    expect(adapter.isInitialized()).toBe(false);
    const first = adapter.initialize();
    expect(adapter.initialize()).toBe(first);
    expect(scopes).toEqual(['owner-a-dev']);
    expect(first.listSavedPlaces()).toEqual([]);
    expect(
      first.savePlace({
        localSavedEntryId: asLocal('local-native'),
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: '同期SQLite', area: '恵比寿', retention },
      }).status,
    ).toBe('saved');
    const harness = harnesses[0];
    expect(harness).toBeDefined();
    expect(harness?.transactions).toBeGreaterThan(1);
    expect(harness?.finalized).toBeGreaterThan(1);

    adapter.close();
    adapter.close();
    expect(harness?.closeCount).toBe(1);
    expect(adapter.getStore()).toBeNull();
    expect(() => first.listSavedPlaces()).toThrow('SQLITE_CLOSED');

    const reopened = adapter.initialize();
    expect(reopened).not.toBe(first);
    expect(reopened.listSavedPlaces()).toEqual([]);
    expect(scopes).toEqual(['owner-a-dev', 'owner-a-dev']);
    adapter.close();
  });

  it('rolls back a failed operation without leaking a partial saved row', () => {
    const adapter = createNativeSqliteAdapter(optionsFor(driverFor()));
    const store = adapter.initialize();
    const harness = harnesses[0];
    if (harness === undefined) throw new Error('harness was not opened');
    harness.failSavedPlaceSelect = true;

    expect(() =>
      store.savePlace({
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: 'ロールバック対象', area: '恵比寿', retention },
      }),
    ).toThrow('injected operation failure');
    expect(harness.rollbacks).toBe(1);
    expect(rawCount(harness.raw, 'saved_place')).toBe(0);

    harness.failSavedPlaceSelect = false;
    expect(
      store.savePlace({
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: '再試行', area: '恵比寿', retention },
      }).status,
    ).toBe('saved');
    expect(rawCount(harness.raw, 'saved_place')).toBe(1);
    adapter.close();
  });

  it('closes a handle after failed initialization and retries cleanly', () => {
    const adapter = createNativeSqliteAdapter(optionsFor(driverFor(true)));
    expect(() => adapter.initialize()).toThrow('injected initialization failure');
    const failed = harnesses[0];
    expect(failed?.closeCount).toBe(1);
    expect(adapter.isInitialized()).toBe(false);
    expect(adapter.getStore()).toBeNull();

    const store = adapter.initialize();
    expect(store.listSavedPlaces()).toEqual([]);
    expect(scopes).toEqual(['owner-a-dev', 'owner-a-dev']);
    adapter.close();
  });

  it('requires an opaque scope and keeps distinct scopes isolated', () => {
    expect(isValidStorageScope('owner-a-dev')).toBe(true);
    expect(isValidStorageScope(`a${'b'.repeat(238)}`)).toBe(true);
    expect(isValidStorageScope(`a${'b'.repeat(240)}`)).toBe(false);
    expect(isValidStorageScope('../owner-a')).toBe(false);
    expect(isValidStorageScope('')).toBe(false);
    expect(() => createNativeSqliteAdapter(optionsFor(driverFor(), '../owner-a'))).toThrow(
      'SQLITE_INVALID_STORAGE_SCOPE',
    );
    expect(scopes).toEqual([]);

    const driver = driverFor();
    const first = createNativeSqliteAdapter(optionsFor(driver, 'owner-a-dev'));
    const second = createNativeSqliteAdapter(optionsFor(driver, 'owner-b-dev'));
    const firstStore = first.initialize();
    firstStore.saveThread({
      id: 'thread-a',
      createdAt: '2026-09-08T04:30:00+09:00',
      expiresAt: '2026-09-08T05:00:00+09:00',
    });
    expect(firstStore.listThreads()).toMatchObject([{ id: 'thread-a' }]);
    expect(second.initialize().listTurns('thread-a')).toEqual([]);
    expect(second.initialize().listThreads()).toEqual([]);
    expect(scopes).toEqual(['owner-a-dev', 'owner-b-dev']);
    first.close();
    second.close();
  });
});

const rawCount = (raw: DatabaseSync, table: string): number => {
  const row = raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  const count = row?.count;
  if (typeof count !== 'number') throw new Error('count query failed');
  return count;
};
