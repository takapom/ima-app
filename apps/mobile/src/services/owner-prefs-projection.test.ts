import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Preferences, PrefsReadResponse, PrefsWriteResponse } from '@ima/contracts';
import type { OwnerPrefsClient } from './api/owner-client';
import type { ApiResult } from './api/api';
import { createOwnerPrefsProjection } from './owner-prefs-projection';
import { createSqliteStore } from './sqlite/store';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
  SqliteConnection,
  SqliteStore,
  SqliteValue,
} from './sqlite/types';
import type { JourneyConditions } from '../state/journey-input';

const conditions: JourneyConditions = {
  stationLabel: '恵比寿',
  stationSupport: 'unknown',
  maxWalkMinutes: 15,
  budget: 'normal',
};

const prefs: Preferences = {
  homeStationRef: 'station-ebisu',
  maxWalkMinutes: 20,
  minimumStayMinutes: 30,
  areaText: '恵比寿',
  budget: 'cheap',
};

const success = <T>(requestId: string, data: T): ApiResult<T> => ({
  ok: true,
  requestId,
  data,
});

const conflictFailure = <T>(requestId: string): ApiResult<T> => ({
  ok: false,
  requestId,
  error: {
    kind: 'http',
    status: 409,
    publicError: {
      schemaVersion: 'v1',
      requestId,
      status: 409,
      code: 'CONFLICT',
      message: 'failed',
    },
    retryAfterSeconds: null,
  },
});

const internalFailure = <T>(requestId: string): ApiResult<T> => ({
  ok: false,
  requestId,
  error: {
    kind: 'http',
    status: 500,
    publicError: {
      schemaVersion: 'v1',
      requestId,
      status: 500,
      code: 'INTERNAL',
      message: 'failed',
    },
    retryAfterSeconds: null,
  },
});

const localId = (value: string): LocalSavedEntryId => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid id');
  return value as LocalSavedEntryId;
};

const serverRef = (value: string): ServerSavedPlaceRef => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid ref');
  return value as ServerSavedPlaceRef;
};

const identifierRetention = {
  retentionDecision: 'allow' as const,
  retentionMode: 'identifier_indefinite_owner_scoped' as const,
  sessionExpiresAt: '2026-09-11T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
};

const displayRetention = {
  ...identifierRetention,
  retentionMode: 'provider_limited' as const,
  freshUntil: '2026-09-11T04:00:00+09:00',
  displayUntil: '2026-09-11T05:00:00+09:00',
  retentionUntil: '2026-09-11T05:00:00+09:00',
  deletionScheduledAt: '2026-09-11T05:00:00+09:00',
  restoreMode: 'full' as const,
};

type Opened = { readonly raw: DatabaseSync; readonly store: SqliteStore };

const databases: DatabaseSync[] = [];

const openStore = (): Opened => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
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
  let next = 0;
  return {
    raw,
    store: createSqliteStore(connection, {
      clock: { now: () => '2026-09-10T23:00:00+09:00' },
      nextLocalSavedEntryId: () => localId(`local-${++next}`),
    }),
  };
};

const apiFor = (overrides: Partial<OwnerPrefsClient> = {}): OwnerPrefsClient => ({
  getPrefs: () =>
    Promise.resolve(
      success<PrefsReadResponse>('request-get', {
        schemaVersion: 'v1',
        requestId: 'request-get',
        revision: 3,
        prefs,
      }),
    ),
  putPrefs: (input) => {
    const requestId =
      typeof input === 'object' &&
      input !== null &&
      'requestId' in input &&
      typeof input.requestId === 'string'
        ? input.requestId
        : 'request-put';
    return Promise.resolve(
      success<PrefsWriteResponse>(requestId, {
        schemaVersion: 'v1',
        requestId,
        revision: 4,
      }),
    );
  },
  listSaved: () =>
    Promise.resolve(
      success('request-list', {
        schemaVersion: 'v1',
        requestId: 'request-list',
        savedPlaceRefs: [],
        decided: [],
      }),
    ),
  ...overrides,
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('owner prefs projection', () => {
  it('hydrates server prefs into sqlite without replacing station_label', async () => {
    const opened = openStore();
    opened.store.savePreferences({ ...prefs, maxWalkMinutes: 8, stationLabel: '渋谷' });
    const projection = createOwnerPrefsProjection({
      api: apiFor(),
      sqlite: opened.store,
      requestIdFactory: () => 'request-1',
      now: () => '2026-09-10T23:00:00+09:00',
    });

    await expect(projection.hydrate()).resolves.toEqual({ prefs: 'synced', saved: 'synced' });
    expect(opened.store.readPreferences()).toMatchObject({
      ...prefs,
      stationLabel: '渋谷',
    });
    expect(projection.read(conditions)).toMatchObject({
      status: 'available',
      source: 'stored',
      conditions: { ...conditions, stationLabel: '渋谷', maxWalkMinutes: 20, budget: 'cheap' },
    });
    const available = projection.read(conditions);
    expect(available.status === 'available' ? available.stale : 'missing').toBeUndefined();
  });

  it('keeps sqlite and marks stored prefs stale when GET prefs fails', async () => {
    const opened = openStore();
    opened.store.savePreferences({ ...prefs, stationLabel: '渋谷' });
    const projection = createOwnerPrefsProjection({
      api: apiFor({
        getPrefs: () => Promise.resolve(internalFailure('request-get')),
      }),
      sqlite: opened.store,
      requestIdFactory: () => 'request-1',
    });

    await expect(projection.hydrate()).resolves.toEqual({ prefs: 'stale', saved: 'synced' });
    expect(opened.store.readPreferences()).toMatchObject({ ...prefs, stationLabel: '渋谷' });
    expect(projection.read(conditions)).toMatchObject({
      status: 'available',
      source: 'stored',
      stale: true,
      conditions: { ...conditions, stationLabel: '渋谷', maxWalkMinutes: 20, budget: 'cheap' },
    });
  });

  it('reconciles saved refs without wiping local-only or existing display rows', async () => {
    const opened = openStore();
    const keep = opened.store.savePlace({
      serverSavedPlaceRef: serverRef('saved-keep'),
      referenceRetention: identifierRetention,
      display: { name: '夜カフェ', area: '恵比寿', retention: displayRetention },
    });
    opened.store.savePlace({
      serverSavedPlaceRef: serverRef('saved-extra'),
      referenceRetention: identifierRetention,
      display: null,
    });
    opened.store.savePlace({
      localSavedEntryId: localId('local-tonight'),
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: '今夜', area: '中目黒', retention: displayRetention },
    });
    const projection = createOwnerPrefsProjection({
      api: apiFor({
        getPrefs: () =>
          Promise.resolve(
            success('request-get', {
              schemaVersion: 'v1',
              requestId: 'request-get',
              revision: 0,
              prefs: null,
            }),
          ),
        listSaved: () =>
          Promise.resolve(
            success('request-list', {
              schemaVersion: 'v1',
              requestId: 'request-list',
              savedPlaceRefs: ['saved-keep', 'saved-new'],
              decided: [],
            }),
          ),
      }),
      sqlite: opened.store,
      requestIdFactory: () => 'request-1',
      now: () => '2026-09-10T23:00:00+09:00',
    });

    await expect(projection.hydrate()).resolves.toEqual({ prefs: 'synced', saved: 'synced' });
    const rows = opened.store.listSavedPlaces();
    expect(rows.map((row) => row.serverSavedPlaceRef).sort()).toEqual(
      ['saved-keep', 'saved-new', null].sort(),
    );
    expect(rows.find((row) => row.serverSavedPlaceRef === 'saved-keep')).toMatchObject({
      name: '夜カフェ',
      restoreMode: 'full',
      localSavedEntryId: keep.status === 'rejected' ? 'missing' : keep.place.localSavedEntryId,
    });
    expect(rows.find((row) => row.serverSavedPlaceRef === 'saved-new')).toMatchObject({
      name: null,
      restoreMode: 'reference_only',
      needsRefetch: true,
    });
    expect(rows.find((row) => row.localSavedEntryId === 'local-tonight')).toMatchObject({
      serverSavedPlaceRef: null,
      name: '今夜',
    });
  });

  it('writes sqlite only after PUT succeeds and omits station_label from the body', async () => {
    const opened = openStore();
    opened.store.savePreferences({ ...prefs, stationLabel: '渋谷' });
    const bodies: unknown[] = [];
    const projection = createOwnerPrefsProjection({
      api: apiFor({
        getPrefs: () =>
          Promise.resolve(
            success('request-get', {
              schemaVersion: 'v1',
              requestId: 'request-get',
              revision: 2,
              prefs,
            }),
          ),
        putPrefs: (input) => {
          bodies.push(input);
          return Promise.resolve(
            success('request-put', { schemaVersion: 'v1', requestId: 'request-put', revision: 3 }),
          );
        },
      }),
      sqlite: opened.store,
      requestIdFactory: () => 'request-put',
    });
    await projection.hydrate();

    await expect(
      projection.save({
        ...conditions,
        maxWalkMinutes: 10,
        budget: 'normal',
        stationLabel: '新宿',
      }),
    ).resolves.toEqual({
      status: 'saved',
      preferences: {
        homeStationRef: 'station-ebisu',
        maxWalkMinutes: 10,
        minimumStayMinutes: 30,
        areaText: '恵比寿',
        budget: 'normal',
      },
    });
    expect(bodies).toEqual([
      {
        schemaVersion: 'v1',
        requestId: 'request-put',
        expectedRevision: 2,
        prefs: {
          homeStationRef: 'station-ebisu',
          maxWalkMinutes: 10,
          minimumStayMinutes: 30,
          areaText: '恵比寿',
          budget: 'normal',
        },
      },
    ]);
    expect(opened.store.readPreferences()).toMatchObject({
      maxWalkMinutes: 10,
      budget: 'normal',
      stationLabel: '新宿',
    });
  });

  it('skips PUT when only the device station label changed', async () => {
    const opened = openStore();
    opened.store.savePreferences({
      ...prefs,
      maxWalkMinutes: 15,
      budget: 'normal',
      stationLabel: '渋谷',
    });
    let puts = 0;
    const projection = createOwnerPrefsProjection({
      api: apiFor({
        putPrefs: () => {
          puts += 1;
          return Promise.resolve(
            success('request-put', { schemaVersion: 'v1', requestId: 'request-put', revision: 1 }),
          );
        },
      }),
      sqlite: opened.store,
      requestIdFactory: () => 'request-put',
    });

    await expect(projection.save({ ...conditions, stationLabel: '新宿' })).resolves.toMatchObject({
      status: 'saved',
    });
    expect(puts).toBe(0);
    expect(opened.store.readPreferences()?.stationLabel).toBe('新宿');
  });

  it('retries a 409 once after GET and leaves sqlite unchanged when the retry fails', async () => {
    const opened = openStore();
    opened.store.savePreferences({ ...prefs, stationLabel: '渋谷' });
    const puts: number[] = [];
    let putAttempts = 0;
    const projection = createOwnerPrefsProjection({
      api: apiFor({
        getPrefs: () =>
          Promise.resolve(
            success('request-get', {
              schemaVersion: 'v1',
              requestId: 'request-get',
              revision: puts.length === 0 ? 1 : 7,
              prefs,
            }),
          ),
        putPrefs: (input) => {
          putAttempts += 1;
          const expectedRevision =
            typeof input === 'object' &&
            input !== null &&
            'expectedRevision' in input &&
            typeof input.expectedRevision === 'number'
              ? input.expectedRevision
              : -1;
          puts.push(expectedRevision);
          return Promise.resolve(conflictFailure('request-put'));
        },
      }),
      sqlite: opened.store,
      requestIdFactory: () => 'request-put',
    });
    await projection.hydrate();

    await expect(projection.save({ ...conditions, budget: 'any' })).resolves.toEqual({
      status: 'failed',
      reason: 'api',
    });
    expect(putAttempts).toBe(2);
    expect(puts).toEqual([1, 7]);
    expect(opened.store.readPreferences()).toMatchObject({ budget: 'cheap', stationLabel: '渋谷' });
  });

  it('uses the refreshed revision on a successful 409 retry', async () => {
    const opened = openStore();
    opened.store.savePreferences({ ...prefs, stationLabel: '渋谷' });
    const puts: number[] = [];
    let putAttempts = 0;
    const projection = createOwnerPrefsProjection({
      api: apiFor({
        getPrefs: () =>
          Promise.resolve(
            success('request-get', {
              schemaVersion: 'v1',
              requestId: 'request-get',
              revision: putAttempts === 0 ? 1 : 8,
              prefs,
            }),
          ),
        putPrefs: (input) => {
          const expectedRevision =
            typeof input === 'object' &&
            input !== null &&
            'expectedRevision' in input &&
            typeof input.expectedRevision === 'number'
              ? input.expectedRevision
              : -1;
          puts.push(expectedRevision);
          putAttempts += 1;
          return putAttempts === 1
            ? Promise.resolve(conflictFailure('request-put'))
            : Promise.resolve(
                success('request-put', {
                  schemaVersion: 'v1',
                  requestId: 'request-put',
                  revision: 9,
                }),
              );
        },
      }),
      sqlite: opened.store,
      requestIdFactory: () => 'request-put',
    });
    await projection.hydrate();

    await expect(projection.save({ ...conditions, budget: 'any' })).resolves.toMatchObject({
      status: 'saved',
      preferences: { budget: 'any' },
    });
    expect(puts).toEqual([1, 8]);
    expect(opened.store.readPreferences()?.budget).toBe('any');
  });
});
