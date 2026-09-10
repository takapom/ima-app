import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RetentionMetadata } from '@ima/contracts';
import { createSqliteStore } from './store';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
  SqliteConnection,
  SqliteValue,
} from './types';

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const asServer = (value: string): ServerSavedPlaceRef => value as ServerSavedPlaceRef;

const retention = (mode: 'full' | 'reference' = 'full'): RetentionMetadata =>
  mode === 'reference'
    ? {
        retentionDecision: 'allow',
        retentionMode: 'identifier_indefinite_owner_scoped',
        sessionExpiresAt: '2026-09-08T05:00:00+09:00',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'reference_only',
        policyStatus: 'available',
        displayPolicyStatus: 'available',
      }
    : {
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

const open = () => {
  const raw = new DatabaseSync(':memory:');
  const connection: SqliteConnection = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        run: (...values: SqliteValue[]) => statement.run(...values),
        get: (...values: SqliteValue[]) => statement.get(...values),
        all: (...values: SqliteValue[]) => statement.all(...values),
      };
    },
  };
  return { raw, connection };
};

describe('saved place identity', () => {
  it('keeps an issued server reference immutable and permits only first attachment', () => {
    const database = open();
    const store = createSqliteStore(database.connection, {
      clock: { now: () => '2026-09-08T04:30:00+09:00' },
      nextLocalSavedEntryId: () => asLocal('generated'),
    });
    const issued = store.savePlace({
      localSavedEntryId: asLocal('issued-local'),
      serverSavedPlaceRef: asServer('server-one'),
      referenceRetention: retention('reference'),
      display: null,
    });
    expect(issued.status).toBe('saved');
    expect(
      store.savePlace({
        localSavedEntryId: asLocal('issued-local'),
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: '再付替え', area: '恵比寿', retention: retention() },
      }),
    ).toEqual({ status: 'rejected', reason: 'invalid_input' });
    expect(
      store.savePlace({
        localSavedEntryId: asLocal('issued-local'),
        serverSavedPlaceRef: asServer('server-two'),
        referenceRetention: retention('reference'),
        display: null,
      }),
    ).toEqual({ status: 'rejected', reason: 'invalid_input' });
    const same = store.savePlace({
      localSavedEntryId: asLocal('issued-local'),
      serverSavedPlaceRef: asServer('server-one'),
      referenceRetention: retention('reference'),
      display: null,
    });
    expect(same.status).toBe('already_saved');
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM saved_place').get()).toEqual({
      count: 1,
    });
    database.raw.close();
  });

  it('allows a local row without a server reference to attach once', () => {
    const database = open();
    const store = createSqliteStore(database.connection, {
      clock: { now: () => '2026-09-08T04:30:00+09:00' },
      nextLocalSavedEntryId: () => asLocal('generated'),
    });
    expect(
      store.savePlace({
        localSavedEntryId: asLocal('attach-local'),
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: '付与前', area: '恵比寿', retention: retention() },
      }).status,
    ).toBe('saved');
    const attached = store.savePlace({
      localSavedEntryId: asLocal('attach-local'),
      serverSavedPlaceRef: asServer('server-attached'),
      referenceRetention: retention('reference'),
      display: null,
    });
    expect(attached).toMatchObject({
      status: 'already_saved',
      place: { localSavedEntryId: 'attach-local', serverSavedPlaceRef: 'server-attached' },
    });
    database.raw.close();
  });
});
