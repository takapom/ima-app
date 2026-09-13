import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JourneyApiControllerBinding } from './journey-api-binding';
import type { ApiFetch } from './api';
import {
  createThreadResponse,
  json,
  openStore,
  referenceRetention,
  requestBodyFor,
  runtimeFor,
  searchRequestFor,
  searchResponse,
  stringField,
  visibleCandidate,
} from './mobile-runtime-storage-fixtures';

type BoundBinding = JourneyApiControllerBinding & {
  readonly storage: NonNullable<JourneyApiControllerBinding['storage']>;
};

const requireBinding = (runtime: ReturnType<typeof runtimeFor>): BoundBinding => {
  const binding = runtime.binding;
  if (binding === null || binding.storage === undefined) {
    throw new Error('formal storage should be connected');
  }
  return { ...binding, storage: binding.storage };
};

const savedResponse = (body: Record<string, unknown>, savedPlaceRef: string) =>
  json(
    {
      schemaVersion: 'v1',
      requestId: stringField(body, 'requestId'),
      candidateId: stringField(body, 'candidateId'),
      savedPlaceRef,
    },
    201,
  );

const cancelledResponse = (body: Record<string, unknown>) =>
  json(
    {
      schemaVersion: 'v1',
      requestId: stringField(body, 'requestId'),
      threadId: 'thread-runtime',
      turnId: stringField(body, 'turnId'),
      revision: 3,
      state: 'cancelled',
    },
    200,
  );

const createAndSearch = async (binding: JourneyApiControllerBinding): Promise<void> => {
  await expect(
    binding.controller.createThread(binding.requests.createThread()),
  ).resolves.toMatchObject({ ok: true });
  await expect(binding.controller.search(searchRequestFor(binding))).resolves.toMatchObject({
    ok: true,
  });
};

describe('mobile runtime saved-reference scope composition', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('rejects saves while the controller is pending', async () => {
    const opened = openStore();
    databases.push(opened.database);
    let searchCount = 0;
    let savedCalls = 0;
    let pendingRequestId: string | undefined;
    let releaseSearch: ((response: Response) => void) | undefined;
    let announceSearch: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => {
      announceSearch = resolve;
    });
    const delayedSearch = new Promise<Response>((resolve) => {
      releaseSearch = resolve;
    });
    const fetchImpl: ApiFetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = requestBodyFor(init);
      if (url.endsWith('/v1/threads')) {
        return Promise.resolve(json(createThreadResponse(stringField(body, 'requestId')), 201));
      }
      if (url.endsWith('/v1/search')) {
        searchCount += 1;
        if (searchCount === 1) {
          return Promise.resolve(json(searchResponse(stringField(body, 'requestId')), 200));
        }
        pendingRequestId = stringField(body, 'requestId');
        announceSearch?.();
        return delayedSearch;
      }
      savedCalls += 1;
      return Promise.resolve(savedResponse(body, 'saved-ref-pending'));
    };
    const binding = requireBinding(
      runtimeFor(fetchImpl, {
        sqlite: opened.store,
        referenceRetentionFor: () => referenceRetention,
      }),
    );
    await createAndSearch(binding);

    const pendingSearch = binding.controller.search(searchRequestFor(binding, 2));
    await searchStarted;
    expect(binding.controller.getState().status).toBe('pending');
    await expect(
      binding.storage.saveCandidate(visibleCandidate, { idempotencyKey: 'save-pending' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(savedCalls).toBe(0);
    if (releaseSearch === undefined || pendingRequestId === undefined) {
      throw new Error('pending search was not started');
    }
    releaseSearch(json(searchResponse(pendingRequestId, 3), 200));
    await expect(pendingSearch).resolves.toMatchObject({ ok: true });
  });

  it('rejects saves after controller cancellation', async () => {
    const opened = openStore();
    databases.push(opened.database);
    let savedCalls = 0;
    const fetchImpl: ApiFetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = requestBodyFor(init);
      if (url.endsWith('/v1/threads')) {
        return Promise.resolve(json(createThreadResponse(stringField(body, 'requestId')), 201));
      }
      if (url.endsWith('/v1/search')) {
        return Promise.resolve(json(searchResponse(stringField(body, 'requestId')), 200));
      }
      if (url.endsWith('/v1/threads/thread-runtime/cancel')) {
        return Promise.resolve(cancelledResponse(body));
      }
      savedCalls += 1;
      return Promise.resolve(savedResponse(body, 'saved-ref-cancelled'));
    };
    const binding = requireBinding(
      runtimeFor(fetchImpl, {
        sqlite: opened.store,
        referenceRetentionFor: () => referenceRetention,
      }),
    );
    await createAndSearch(binding);
    await expect(
      binding.controller.cancel(
        'thread-runtime',
        binding.requests.cancel({
          threadId: 'thread-runtime',
          revision: 2,
          turnId: 'turn-runtime-2',
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(binding.controller.getState().status).toBe('cancelled');
    const savePlace = vi.spyOn(opened.store, 'savePlace');
    await expect(
      binding.storage.saveCandidate(visibleCandidate, { idempotencyKey: 'save-cancelled-state' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(savedCalls).toBe(0);
    expect(savePlace).not.toHaveBeenCalled();
  });

  it('does not persist when the session expires while the save response is pending', async () => {
    const opened = openStore();
    databases.push(opened.database);
    let nowValue = '2026-09-10T12:00:00.000Z';
    let savedCalls = 0;
    let pendingSavedBody: Record<string, unknown> | undefined;
    let releaseSaved: ((response: Response) => void) | undefined;
    let announceSaved: (() => void) | undefined;
    const savedStarted = new Promise<void>((resolve) => {
      announceSaved = resolve;
    });
    const delayedSaved = new Promise<Response>((resolve) => {
      releaseSaved = resolve;
    });
    const fetchImpl: ApiFetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = requestBodyFor(init);
      if (url.endsWith('/v1/threads')) {
        return Promise.resolve(json(createThreadResponse(stringField(body, 'requestId')), 201));
      }
      if (url.endsWith('/v1/search')) {
        return Promise.resolve(json(searchResponse(stringField(body, 'requestId')), 200));
      }
      savedCalls += 1;
      pendingSavedBody = body;
      announceSaved?.();
      return delayedSaved;
    };
    const binding = requireBinding(
      runtimeFor(
        fetchImpl,
        {
          sqlite: opened.store,
          referenceRetentionFor: () => referenceRetention,
        },
        () => nowValue,
      ),
    );
    await createAndSearch(binding);
    const savePlace = vi.spyOn(opened.store, 'savePlace');
    const saving = binding.storage.saveCandidate(visibleCandidate, {
      idempotencyKey: 'save-expiring',
    });
    await savedStarted;
    nowValue = '2026-09-10T13:00:00.000Z';
    if (releaseSaved === undefined || pendingSavedBody === undefined) {
      throw new Error('save request was not started');
    }
    releaseSaved(savedResponse(pendingSavedBody, 'saved-ref-expiring'));
    await expect(saving).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(savedCalls).toBe(1);
    expect(savePlace).not.toHaveBeenCalled();
  });
});
