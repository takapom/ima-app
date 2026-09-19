import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { RetentionMetadata, Preferences } from '@ima/contracts';
import { createSqliteStore } from '@mobile/platform/sqlite/store';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
  SqliteConnection,
  SqliteValue,
} from '@mobile/platform/sqlite/types';

type OpenedDatabase = { readonly raw: DatabaseSync; readonly connection: SqliteConnection };

const openDatabase = (filename = ':memory:'): OpenedDatabase => {
  const raw = new DatabaseSync(filename);
  const connection: SqliteConnection = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        run: (...values: SqliteValue[]) => {
          statement.run(...values);
        },
        get: (...values: SqliteValue[]) => {
          const row = statement.get(...values);
          return row;
        },
        all: (...values: SqliteValue[]) =>
          statement.all(...values).map((row) => row as Record<string, unknown>),
      };
    },
  };
  return { raw, connection };
};

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const asServer = (value: string): ServerSavedPlaceRef => value as ServerSavedPlaceRef;

const fullRetention = (overrides: Partial<RetentionMetadata> = {}): RetentionMetadata => ({
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
  ...overrides,
});

const identifierRetention = (): RetentionMetadata => ({
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
});

const unknownRetention = (): RetentionMetadata => ({
  retentionDecision: 'unknown',
  retentionMode: 'session_only',
  sessionExpiresAt: '2026-09-08T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
});

const preferences: Preferences = {
  homeStationRef: 'station-ebisu',
  maxWalkMinutes: 20,
  minimumStayMinutes: 30,
  areaText: '恵比寿',
  budget: 'normal',
};

describe('SQLite retention store', () => {
  const opened: DatabaseSync[] = [];
  let current = '2026-09-08T04:30:00+09:00';
  let sequence = 0;

  const create = (filename = ':memory:') => {
    const database = openDatabase(filename);
    opened.push(database.raw);
    return createSqliteStore(database.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal(`local-${++sequence}`),
    });
  };

  afterEach(() => {
    for (const database of opened.splice(0)) database.close();
    current = '2026-09-08T04:30:00+09:00';
  });

  it('migrates and reopens identifier-only thread state without storing a response body', () => {
    const filename = join(tmpdir(), `ima-m21-${process.pid}-${Date.now()}-${sequence}.sqlite`);
    const firstDatabase = openDatabase(filename);
    opened.push(firstDatabase.raw);
    const first = createSqliteStore(firstDatabase.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal('local-first'),
    });
    first.saveThread({
      id: 'thread-1',
      createdAt: current,
      expiresAt: '2026-09-08T04:45:00+09:00',
    });
    first.saveThread({
      id: 'thread-1',
      createdAt: '2026-09-08T03:00:00+09:00',
      expiresAt: '2026-09-09T05:00:00+09:00',
    });
    expect(
      firstDatabase.connection
        .prepare('SELECT expires_at FROM thread WHERE id = ?')
        .get('thread-1'),
    ).toEqual({
      expires_at: '2026-09-07T19:45:00.000Z',
    });
    first.appendTurn({
      id: 'turn-1',
      threadId: 'thread-1',
      kind: 'search_submitted',
      candidateRef: null,
    });
    expect(
      first.writeSnapshot({
        threadId: 'thread-1',
        responseId: 'response-1',
        revision: 2,
        sessionExpiresAt: '2026-09-08T05:00:00+09:00',
        displayUntil: '2026-09-08T05:00:00+09:00',
        retentionUntil: '2026-09-08T05:00:00+09:00',
        deletionScheduledAt: '2026-09-08T05:00:00+09:00',
      }),
    ).toBe(true);
    first.savePreferences(preferences);

    opened.splice(opened.indexOf(firstDatabase.raw), 1);
    firstDatabase.raw.close();
    const reopened = openDatabase(filename);
    opened.push(reopened.raw);
    const store = createSqliteStore(reopened.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal('local-reopened'),
    });
    expect(store.listTurns('thread-1')).toEqual([
      {
        id: 'turn-1',
        threadId: 'thread-1',
        kind: 'search_submitted',
        candidateRef: null,
        timestamp: '2026-09-07T19:30:00.000Z',
      },
    ]);
    expect(store.readSnapshot('thread-1')).toMatchObject({
      response: null,
      restoreMode: 'reference_only',
      needsRefetch: true,
      revision: 2,
    });
    expect(store.readPreferences()).toMatchObject({
      ...preferences,
      updatedAt: '2026-09-07T19:30:00.000Z',
    });
    opened.splice(opened.indexOf(reopened.raw), 1);
    reopened.raw.close();
    rmSync(filename, { force: true });
  });

  it('stores full display metadata only when its own retention allows it', () => {
    const store = create();
    const result = store.savePlace({
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: '夜カフェ', area: '恵比寿', retention: fullRetention() },
    });
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    expect(result.place).toMatchObject({
      localSavedEntryId: 'local-1',
      serverSavedPlaceRef: null,
      name: '夜カフェ',
      area: '恵比寿',
      restoreMode: 'full',
      needsRefetch: false,
    });
    expect(store.markDecided(result.place.localSavedEntryId, current)).toBe(true);
    expect(store.setStarred(result.place.localSavedEntryId, false)).toBe(true);
    expect(store.listTonightDecisions()).toHaveLength(1);
    expect(store.listSavedPlaces()).toEqual([]);
    expect(store.deleteSavedPlace(result.place.localSavedEntryId)).toBe(true);
    expect(store.deleteSavedPlace(result.place.localSavedEntryId)).toBe(false);
  });

  it('keeps a full payload when displayUntil is absent but bounded retention remains', () => {
    const store = create();
    const result = store.savePlace({
      localSavedEntryId: asLocal('local-no-display-deadline'),
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: {
        name: '期限なし表示境界',
        area: '恵比寿',
        retention: fullRetention({ freshUntil: null, displayUntil: null }),
      },
    });
    expect(result).toMatchObject({
      status: 'saved',
      place: { restoreMode: 'full', displayUntil: null },
    });
    expect(store.listSavedPlaces()).toMatchObject([{ name: '期限なし表示境界', area: '恵比寿' }]);
  });

  it('makes a local-ID retry idempotent and rejects malformed IDs before writing', () => {
    const database = openDatabase();
    opened.push(database.raw);
    const store = createSqliteStore(database.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal('local-retry-generated'),
    });
    const input = {
      localSavedEntryId: asLocal('local-retry'),
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: '再保存店', area: '恵比寿', retention: fullRetention() },
    };
    expect(store.savePlace(input).status).toBe('saved');
    expect(store.savePlace(input).status).toBe('already_saved');
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM saved_place').get()).toEqual({
      count: 1,
    });
    expect(
      store.savePlace({
        localSavedEntryId: asLocal('invalid/local-id'),
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: '不正ID', area: '恵比寿', retention: fullRetention() },
      }),
    ).toEqual({ status: 'rejected', reason: 'invalid_input' });
    expect(
      store.savePlace({
        localSavedEntryId: asLocal('local-server-invalid'),
        serverSavedPlaceRef: asServer('invalid/server-ref'),
        referenceRetention: identifierRetention(),
        display: null,
      }),
    ).toEqual({ status: 'rejected', reason: 'invalid_input' });
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM saved_place').get()).toEqual({
      count: 1,
    });
  });

  it('keeps an owner-scoped server reference while dropping display canaries', () => {
    const database = openDatabase();
    opened.push(database.raw);
    const store = createSqliteStore(database.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal('local-ref'),
    });
    const marker = 'M31_PROVIDER_QUOTE_CANARY';
    const result = store.savePlace({
      serverSavedPlaceRef: asServer('server-place-1'),
      referenceRetention: identifierRetention(),
      display: { name: marker, area: 'area', retention: identifierRetention() },
    });
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    expect(result.place).toMatchObject({
      localSavedEntryId: 'local-ref',
      serverSavedPlaceRef: 'server-place-1',
      name: null,
      area: null,
      restoreMode: 'reference_only',
      needsRefetch: true,
    });
    expect(
      JSON.stringify(database.connection.prepare('SELECT * FROM saved_place').all()),
    ).not.toContain(marker);
    expect(
      store.savePlace({
        serverSavedPlaceRef: asServer('server-place-1'),
        referenceRetention: identifierRetention(),
        display: null,
      }).status,
    ).toBe('already_saved');
  });

  it('denies unknown retention and never writes a denied canary', () => {
    const database = openDatabase();
    opened.push(database.raw);
    const store = createSqliteStore(database.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal('local-denied'),
    });
    expect(
      store.savePlace({
        serverSavedPlaceRef: null,
        referenceRetention: null,
        display: { name: 'M31_GENERATED_CANARY', area: '恵比寿', retention: unknownRetention() },
      }),
    ).toEqual({ status: 'rejected', reason: 'retention_denied' });
    expect(database.connection.prepare('SELECT COUNT(*) AS count FROM saved_place').get()).toEqual({
      count: 0,
    });
  });

  it('expires display payload at the boundary but keeps starred saved identity and does not revive it', () => {
    const store = create();
    const result = store.savePlace({
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: '期限店', area: '恵比寿', retention: fullRetention() },
    });
    if (result.status !== 'saved') throw new Error('save failed');
    const localId = result.place.localSavedEntryId;
    expect(store.markDecided(localId, '2026-09-08T04:59:59+09:00')).toBe(true);
    current = '2026-09-08T05:00:00+09:00';
    const expired = store.listSavedPlaces()[0];
    expect(expired).toMatchObject({
      localSavedEntryId: localId,
      name: null,
      area: null,
      starred: true,
      restoreMode: 'unavailable',
      needsRefetch: true,
    });
    current = '2026-09-08T04:30:00+09:00';
    expect(store.listSavedPlaces()[0]).toMatchObject({ name: null, restoreMode: 'unavailable' });
  });

  it('expires skip and thread state at 05:00 while leaving saved rows intact', () => {
    const store = create();
    store.saveThread({
      id: 'thread-expire',
      createdAt: current,
      expiresAt: '2026-09-09T05:00:00+09:00',
    });
    store.appendTurn({
      id: 'turn-expire',
      threadId: 'thread-expire',
      kind: 'action',
      candidateRef: 'candidate-1',
    });
    store.writeSnapshot({
      threadId: 'thread-expire',
      responseId: 'response-expire',
      revision: 1,
      sessionExpiresAt: '2026-09-08T05:00:00+09:00',
      displayUntil: null,
      retentionUntil: null,
      deletionScheduledAt: null,
    });
    store.saveSkipTonight('candidate-1', '2026-09-09T05:00:00+09:00');
    const saved = store.savePlace({
      serverSavedPlaceRef: asServer('server-stable'),
      referenceRetention: identifierRetention(),
      display: null,
    });
    expect(saved.status).toBe('saved');
    current = '2026-09-08T05:00:00+09:00';
    expect(store.listTurns('thread-expire')).toEqual([]);
    expect(store.readSnapshot('thread-expire')).toBeNull();
    expect(store.isSkippedTonight('candidate-1')).toBe(false);
    expect(store.listSavedPlaces()[0]?.starred).toBe(true);
  });

  it('records a decision without silently turning it into a starred save', () => {
    const store = create();
    const localId = asLocal('decision-only');
    expect(store.markDecided(localId, current)).toBe(true);
    expect(store.listSavedPlaces()).toEqual([]);
    expect(store.listTonightDecisions()).toMatchObject([
      { localSavedEntryId: localId, starred: false, decidedAt: '2026-09-07T19:30:00.000Z' },
    ]);
  });

  it('uses decision time for a new night even when old display metadata expired', () => {
    const store = create();
    const result = store.savePlace({
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: '昨夜の店', area: '恵比寿', retention: fullRetention() },
    });
    if (result.status !== 'saved') throw new Error('save failed');
    current = '2026-09-08T05:30:00+09:00';
    expect(store.markDecided(result.place.localSavedEntryId, current)).toBe(true);
    expect(store.listTonightDecisions()).toMatchObject([
      { localSavedEntryId: result.place.localSavedEntryId, decidedAt: '2026-09-07T20:30:00.000Z' },
    ]);
  });

  it('rejects stale snapshots, survives preference corruption, and rejects future schema versions', () => {
    const database = openDatabase();
    opened.push(database.raw);
    const store = createSqliteStore(database.connection, {
      clock: { now: () => current },
      nextLocalSavedEntryId: () => asLocal('local-corrupt'),
    });
    store.saveThread({
      id: 'thread-1',
      createdAt: current,
      expiresAt: '2026-09-08T05:00:00+09:00',
    });
    expect(
      store.writeSnapshot({
        threadId: 'thread-1',
        responseId: 'response-new',
        revision: 2,
        sessionExpiresAt: '2026-09-08T05:00:00+09:00',
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
      }),
    ).toBe(true);
    expect(
      store.writeSnapshot({
        threadId: 'thread-1',
        responseId: 'response-other',
        revision: 2,
        sessionExpiresAt: '2026-09-08T05:00:00+09:00',
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
      }),
    ).toBe(false);
    expect(
      store.writeSnapshot({
        threadId: 'thread-1',
        responseId: 'response-old',
        revision: 1,
        sessionExpiresAt: '2026-09-08T05:00:00+09:00',
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
      }),
    ).toBe(false);
    store.savePreferences(preferences);
    database.connection.exec("UPDATE prefs SET updated_at = 'invalid'");
    expect(store.readPreferences()).toBeNull();

    const saved = store.savePlace({
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: 'corrupt-payload', area: 'area', retention: fullRetention() },
    });
    if (saved.status !== 'saved') throw new Error('save failed');
    database.connection.exec("UPDATE saved_place SET display_until = 'invalid'");
    expect(store.listSavedPlaces()).toEqual([]);
    expect(database.connection.prepare('SELECT name, area FROM saved_place').get()).toEqual({
      name: null,
      area: null,
    });

    const savedAgain = store.savePlace({
      localSavedEntryId: asLocal('local-corrupt-2'),
      serverSavedPlaceRef: null,
      referenceRetention: null,
      display: { name: 'corrupt-retention', area: 'area', retention: fullRetention() },
    });
    if (savedAgain.status !== 'saved') throw new Error('save failed');
    database.connection.exec('UPDATE saved_place SET retention_until = NULL');
    expect(store.listSavedPlaces()).toEqual([]);
    expect(database.connection.prepare('SELECT name, area FROM saved_place').get()).toEqual({
      name: null,
      area: null,
    });

    const future = openDatabase();
    opened.push(future.raw);
    future.connection.exec('PRAGMA user_version = 99');
    expect(() =>
      createSqliteStore(future.connection, {
        clock: { now: () => current },
        nextLocalSavedEntryId: () => asLocal('future'),
      }),
    ).toThrow('SQLITE_UNSUPPORTED_SCHEMA_VERSION');
  });
});
