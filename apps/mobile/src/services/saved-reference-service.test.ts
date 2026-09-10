import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PublicPlaceDetailsData,
  RetentionMetadata,
  SavedReferenceCreateRequest,
  SavedReferenceCreateResponse,
} from '@ima/contracts';
import { createSavedReferenceService, type SavedReferenceScope } from './saved-reference-service';
import type { SavedReferenceRefreshResponse } from './api/saved-reference-refresh';
import { createSqliteStore } from './sqlite/store';
import type {
  LocalSavedEntryId,
  ServerSavedPlaceRef,
  SqliteConnection,
  SqliteStore,
  SqliteValue,
} from './sqlite/types';
import type { JourneyApiClient } from './api/types';

const identifierRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'identifier_indefinite_owner_scoped',
  sessionExpiresAt: '2026-09-11T05:00:00+09:00',
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const scope: SavedReferenceScope = { threadId: 'thread-1', revision: 7 };
const saveInput = {
  scope,
  candidateId: 'candidate-1',
  idempotencyKey: 'save-operation-1',
  referenceRetention: identifierRetention,
};

const responseFor = (
  input: SavedReferenceCreateRequest,
  candidateId = input.candidateId,
): { ok: true; data: SavedReferenceCreateResponse; requestId: string } => ({
  ok: true,
  data: {
    schemaVersion: 'v1',
    requestId: input.requestId,
    candidateId,
    savedPlaceRef: 'saved-ref-1',
  },
  requestId: input.requestId,
});

const refreshRetention: RetentionMetadata = {
  retentionDecision: 'allow',
  retentionMode: 'provider_limited',
  sessionExpiresAt: '2026-09-11T05:00:00+09:00',
  freshUntil: '2026-09-11T04:00:00+09:00',
  displayUntil: '2026-09-11T04:30:00+09:00',
  retentionUntil: '2026-09-11T05:00:00+09:00',
  deletionScheduledAt: '2026-09-11T05:00:00+09:00',
  attribution: null,
  restoreMode: 'full',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
};

const refreshData: PublicPlaceDetailsData = {
  items: [
    {
      candidateId: 'candidate-1',
      fields: {
        identity: {
          status: 'known',
          value: {
            name: '夜カフェ',
            area: '恵比寿',
            address: null,
            category: 'cafe',
            businessStatus: 'operational',
            sourceUrl: null,
          },
          evidence: [
            {
              evidenceId: 'evidence-1',
              attribution: null,
              retention: refreshRetention,
            },
          ],
        },
      },
    },
  ],
};

const refreshResponseFor = (requestId: string): SavedReferenceRefreshResponse => ({
  schemaVersion: 'v1',
  requestId,
  savedPlaceRef: 'saved-ref-1',
  candidate: { candidateId: 'candidate-1', evidenceIds: ['evidence-1'] },
  data: refreshData,
});

type ApiStub = Pick<
  JourneyApiClient,
  'createSavedReference' | 'deleteSavedReference' | 'refreshSavedReference'
>;

const apiStub = (
  createSavedReference: JourneyApiClient['createSavedReference'],
  deleteSavedReference: JourneyApiClient['deleteSavedReference'] = (_savedPlaceRef, input) =>
    Promise.resolve({ ok: true, data: null, requestId: input.requestId }),
  refreshSavedReference: JourneyApiClient['refreshSavedReference'] = () =>
    Promise.resolve({
      ok: true,
      data: refreshResponseFor('refresh-request'),
      requestId: 'refresh-request',
    }),
): ApiStub => ({ createSavedReference, deleteSavedReference, refreshSavedReference });

const asLocal = (value: string): LocalSavedEntryId => value as LocalSavedEntryId;
const asServer = (value: string): ServerSavedPlaceRef => value as ServerSavedPlaceRef;

type Opened = { readonly raw: DatabaseSync; readonly store: SqliteStore };

const openStore = (): Opened => {
  const raw = new DatabaseSync(':memory:');
  const connection: SqliteConnection = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        run: (...values: SqliteValue[]) => statement.run(...values),
        get: (...values: SqliteValue[]) => statement.get(...values),
        all: (...values: SqliteValue[]) =>
          statement.all(...values).map((row) => row as Record<string, unknown>),
      };
    },
  };
  return {
    raw,
    store: createSqliteStore(connection, {
      clock: { now: () => '2026-09-10T23:00:00+09:00' },
      nextLocalSavedEntryId: () => asLocal('local-1'),
    }),
  };
};

describe('saved reference service', () => {
  const databases: DatabaseSync[] = [];
  let currentScope: SavedReferenceScope | null = scope;
  let requestSequence = 0;

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    currentScope = scope;
    requestSequence = 0;
  });

  const create = (api: ApiStub) => {
    const opened = openStore();
    databases.push(opened.raw);
    return {
      store: opened.store,
      service: createSavedReferenceService({
        api,
        sqlite: opened.store,
        currentScope: () => currentScope,
        requestIdFactory: () => `request-${++requestSequence}`,
      }),
    };
  };

  it('uses the server ref as the SQLite identity and keeps retries idempotent', async () => {
    const requests: Array<{
      readonly threadId: string;
      readonly input: SavedReferenceCreateRequest;
    }> = [];
    const { service, store } = create(
      apiStub((threadId, input) => {
        requests.push({ threadId, input });
        return Promise.resolve(responseFor(input));
      }),
    );

    const first = await service.save(saveInput);
    const second = await service.save(saveInput);
    expect(first).toMatchObject({
      status: 'saved',
      localSavedEntryId: 'local-1',
      serverSavedPlaceRef: 'saved-ref-1',
    });
    expect(second).toMatchObject({ status: 'already_saved', serverSavedPlaceRef: 'saved-ref-1' });
    expect(requests.map((request) => [request.threadId, request.input.idempotencyKey])).toEqual([
      ['thread-1', 'save-operation-1'],
      ['thread-1', 'save-operation-1'],
    ]);
    expect(store.listSavedPlaces()).toHaveLength(1);
    expect(store.listSavedPlaces()[0]?.name).toBeNull();
    expect(store.listSavedPlaces()[0]?.serverSavedPlaceRef).toBe('saved-ref-1');
  });

  it('suppresses a late save after the active thread or revision changes', async () => {
    let resolve: ((result: ReturnType<typeof responseFor>) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((done) => {
      markStarted = done;
    });
    const { service, store } = create(
      apiStub((_threadId, _input) => {
        markStarted?.();
        return new Promise((done) => {
          resolve = done;
        });
      }),
    );
    const pending = service.save(saveInput);
    await started;
    currentScope = { threadId: 'thread-2', revision: 1 };
    resolve?.(
      responseFor({
        schemaVersion: 'v1',
        requestId: 'request-late',
        candidateId: saveInput.candidateId,
        revision: saveInput.scope.revision,
        idempotencyKey: saveInput.idempotencyKey,
      }),
    );

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(store.listSavedPlaces()).toEqual([]);
  });

  it('suppresses a late save after cancellation without writing the local store', async () => {
    let resolve: ((result: ReturnType<typeof responseFor>) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((done) => {
      markStarted = done;
    });
    const { service, store } = create(
      apiStub((_threadId, _input) => {
        markStarted?.();
        return new Promise((done) => {
          resolve = done;
        });
      }),
    );
    const controller = new AbortController();
    const pending = service.save({ ...saveInput, signal: controller.signal });
    await started;
    controller.abort();
    resolve?.(
      responseFor({
        schemaVersion: 'v1',
        requestId: 'request-cancelled',
        candidateId: saveInput.candidateId,
        revision: saveInput.scope.revision,
        idempotencyKey: saveInput.idempotencyKey,
      }),
    );

    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'aborted' });
    expect(store.listSavedPlaces()).toEqual([]);
  });

  it('denies unknown retention and mismatched candidate responses before local persistence', async () => {
    let calls = 0;
    const { service, store } = create(
      apiStub((_threadId, input) => {
        calls += 1;
        return Promise.resolve(responseFor(input, 'candidate-2'));
      }),
    );
    await expect(
      service.save({
        ...saveInput,
        referenceRetention: { ...identifierRetention, policyStatus: 'policy_withheld' },
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'retention_denied' });
    await expect(service.save(saveInput)).resolves.toEqual({
      status: 'failed',
      reason: 'invalid_input',
    });
    expect(calls).toBe(1);
    expect(store.listSavedPlaces()).toEqual([]);
  });

  it('keeps a timeout distinct from user cancellation', async () => {
    const { service, store } = create(
      apiStub((_threadId, input) =>
        Promise.resolve({
          ok: false,
          error: { kind: 'timeout' as const },
          requestId: input.requestId,
        }),
      ),
    );

    await expect(service.save(saveInput)).resolves.toEqual({
      status: 'failed',
      reason: 'api',
      error: { kind: 'timeout' },
    });
    expect(store.listSavedPlaces()).toEqual([]);
  });

  it('returns refreshed public details without writing SQLite state', async () => {
    let refreshCalls = 0;
    const { service, store } = create(
      apiStub(
        (_threadId, input) => Promise.resolve(responseFor(input)),
        undefined,
        (_savedRef, _input) => {
          refreshCalls += 1;
          return Promise.resolve({
            ok: true,
            data: refreshResponseFor('refresh-1'),
            requestId: 'refresh-request',
          });
        },
      ),
    );
    const before = store.listSavedPlaces();

    await expect(
      service.refresh({ savedPlaceRef: asServer('saved-ref-1') }),
    ).resolves.toMatchObject({
      status: 'refreshed',
      savedPlaceRef: 'saved-ref-1',
      candidateId: 'candidate-1',
      evidenceIds: ['evidence-1'],
      data: refreshData,
    });
    expect(refreshCalls).toBe(1);
    expect(store.listSavedPlaces()).toEqual(before);
  });

  it('suppresses a late refresh after cancellation and rejects inconsistent API data', async () => {
    let resolveRefresh:
      | ((result: Awaited<ReturnType<JourneyApiClient['refreshSavedReference']>>) => void)
      | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { service, store } = create(
      apiStub(
        (_threadId, input) => Promise.resolve(responseFor(input)),
        undefined,
        () => {
          markStarted?.();
          return new Promise((resolve) => {
            resolveRefresh = resolve;
          });
        },
      ),
    );
    const controller = new AbortController();
    const pending = service.refresh({
      savedPlaceRef: asServer('saved-ref-1'),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    resolveRefresh?.({
      ok: true,
      data: refreshResponseFor('refresh-late'),
      requestId: 'refresh-late',
    });
    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'aborted' });
    expect(store.listSavedPlaces()).toEqual([]);

    const inconsistent = create(
      apiStub(
        (_threadId, input) => Promise.resolve(responseFor(input)),
        undefined,
        () =>
          Promise.resolve({
            ok: true,
            data: {
              ...refreshResponseFor('refresh-invalid'),
              candidate: { candidateId: 'candidate-2', evidenceIds: [] },
            },
            requestId: 'refresh-invalid',
          }),
      ),
    );
    await expect(
      inconsistent.service.refresh({ savedPlaceRef: asServer('saved-ref-1') }),
    ).resolves.toEqual({ status: 'failed', reason: 'invalid_input' });
    expect(inconsistent.store.listSavedPlaces()).toEqual([]);
  });

  it('deletes only the matching local reference and ignores a late delete', async () => {
    let deleteCalls = 0;
    const { service, store } = create(
      apiStub(
        (_threadId, input) => Promise.resolve(responseFor(input)),
        (_savedRef, input) => {
          deleteCalls += 1;
          return Promise.resolve({ ok: true, data: null, requestId: input.requestId });
        },
      ),
    );
    const saved = await service.save(saveInput);
    if (saved.status !== 'saved') throw new Error('fixture save failed');
    expect(
      store.savePlace({
        localSavedEntryId: asLocal('other-local'),
        serverSavedPlaceRef: asServer('saved-ref-other'),
        referenceRetention: identifierRetention,
        display: null,
      }),
    ).toMatchObject({ status: 'saved' });

    await expect(
      service.remove({
        savedPlaceRef: saved.serverSavedPlaceRef,
        localSavedEntryId: asLocal('other-local'),
        idempotencyKey: 'delete-wrong-local',
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'invalid_input' });
    expect(store.listSavedPlaces()).toHaveLength(2);
    expect(deleteCalls).toBe(0);

    await expect(
      service.remove({
        savedPlaceRef: saved.serverSavedPlaceRef,
        localSavedEntryId: saved.localSavedEntryId,
        idempotencyKey: 'delete-same',
      }),
    ).resolves.toEqual({ status: 'deleted' });
    expect(deleteCalls).toBe(1);
    await expect(
      service.remove({
        savedPlaceRef: saved.serverSavedPlaceRef,
        localSavedEntryId: saved.localSavedEntryId,
        idempotencyKey: 'delete-same',
      }),
    ).resolves.toEqual({ status: 'already_deleted' });
    expect(deleteCalls).toBe(2);

    let resolveDelete: (() => void) | undefined;
    let markDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>((done) => {
      markDeleteStarted = done;
    });
    const deleteApi = apiStub(
      (_threadId, input) => Promise.resolve(responseFor(input)),
      async (_savedRef, input) => {
        markDeleteStarted?.();
        await new Promise<void>((done) => {
          resolveDelete = done;
        });
        return { ok: true, data: null, requestId: input.requestId };
      },
    );
    const lateDelete = create(deleteApi);
    const lateSaved = await lateDelete.service.save(saveInput);
    if (lateSaved.status !== 'saved') throw new Error('fixture save failed');
    const pending = lateDelete.service.remove({
      savedPlaceRef: lateSaved.serverSavedPlaceRef,
      localSavedEntryId: lateSaved.localSavedEntryId,
      scope,
      idempotencyKey: 'delete-late',
    });
    await deleteStarted;
    currentScope = { threadId: 'thread-2', revision: 2 };
    resolveDelete?.();
    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(lateDelete.store.listSavedPlaces()).toHaveLength(1);
  });
});
