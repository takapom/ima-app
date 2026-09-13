import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiFetch } from './api';
import {
  candidate,
  createThreadResponse,
  json,
  nonVisibleCandidate,
  openStore,
  referenceRetention,
  requestBodyFor,
  runtimeFor,
  searchRequestFor,
  searchResponse,
  stringField,
  visibleCandidate,
} from './mobile-runtime-storage-fixtures';

describe('mobile runtime saved-reference composition', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('keeps storage unavailable until a formal SQLite adapter is injected', () => {
    const runtime = runtimeFor(() => Promise.resolve(new Response(null, { status: 404 })));
    expect(runtime.binding?.storage).toBeUndefined();
  });

  it('reuses the runtime API client and stores only the server reference in SQLite', async () => {
    const opened = openStore();
    databases.push(opened.database);
    const calls: string[] = [];
    const fetchImpl: ApiFetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      const body = requestBodyFor(init);
      if (url.endsWith('/v1/threads')) {
        return Promise.resolve(json(createThreadResponse(stringField(body, 'requestId')), 201));
      }
      if (url.endsWith('/v1/search')) {
        return Promise.resolve(json(searchResponse(stringField(body, 'requestId')), 200));
      }
      if (url.endsWith('/v1/threads/thread-runtime/saved')) {
        return Promise.resolve(
          json(
            {
              schemaVersion: 'v1',
              requestId: stringField(body, 'requestId'),
              candidateId: stringField(body, 'candidateId'),
              savedPlaceRef: 'saved-ref-runtime',
            },
            201,
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const runtime = runtimeFor(fetchImpl, {
      sqlite: opened.store,
      referenceRetentionFor: () => referenceRetention,
    });
    const binding = runtime.binding;
    if (
      binding === null ||
      binding.storage === undefined ||
      binding.savedPlacePreview === undefined
    ) {
      throw new Error('formal storage should be connected');
    }
    expect(binding.savedPlacePreview.listService.list()).toEqual({
      status: 'available',
      items: [],
    });

    await expect(
      binding.controller.createThread(binding.requests.createThread()),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(binding.controller.search(searchRequestFor(binding))).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      binding.storage.saveCandidate(nonVisibleCandidate, { idempotencyKey: 'save-old-card' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(calls).toHaveLength(2);
    await expect(
      binding.storage.saveCandidate(visibleCandidate, { idempotencyKey: 'save-runtime-1' }),
    ).resolves.toMatchObject({
      status: 'saved',
      serverSavedPlaceRef: 'saved-ref-runtime',
    });
    expect(calls).toEqual([
      'http://localhost:8787/v1/threads',
      'http://localhost:8787/v1/search',
      'http://localhost:8787/v1/threads/thread-runtime/saved',
    ]);
    expect(opened.store.listSavedPlaces()).toMatchObject([
      {
        serverSavedPlaceRef: 'saved-ref-runtime',
        name: null,
        area: null,
        restoreMode: 'reference_only',
      },
    ]);
    expect(binding.savedPlacePreview.listService.list()).toMatchObject({
      status: 'available',
      items: [{ serverSavedPlaceRef: 'saved-ref-runtime', name: null, area: null }],
    });
  });

  it('does no API or SQLite I/O for a missing, cancelled, or expired current scope', async () => {
    const opened = openStore();
    databases.push(opened.database);
    let calls = 0;
    const fetchImpl: ApiFetch = (input, init) => {
      calls += 1;
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const body = requestBodyFor(init);
      if (url.endsWith('/v1/search')) {
        return Promise.resolve(json(searchResponse(stringField(body, 'requestId')), 200));
      }
      return Promise.resolve(json(createThreadResponse(stringField(body, 'requestId')), 201));
    };
    const runtime = runtimeFor(fetchImpl, {
      sqlite: opened.store,
      referenceRetentionFor: () => referenceRetention,
    });
    const binding = runtime.binding;
    if (binding === null || binding.storage === undefined) {
      throw new Error('formal storage should be connected');
    }
    const savePlace = vi.spyOn(opened.store, 'savePlace');
    const listSavedPlaces = vi.spyOn(opened.store, 'listSavedPlaces');
    await expect(
      binding.storage.saveCandidate(candidate, { idempotencyKey: 'save-no-thread' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(calls).toBe(0);
    expect(savePlace).not.toHaveBeenCalled();
    expect(listSavedPlaces).not.toHaveBeenCalled();

    const expired = runtimeFor(
      fetchImpl,
      {
        sqlite: opened.store,
        referenceRetentionFor: () => referenceRetention,
      },
      () => '2026-09-10T13:00:00.000Z',
    );
    if (expired.binding === null || expired.binding.storage === undefined) {
      throw new Error('formal storage should be connected');
    }
    await expect(
      expired.binding.controller.createThread(expired.binding.requests.createThread()),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      expired.binding.controller.search(searchRequestFor(expired.binding)),
    ).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(2);
    await expect(
      expired.binding.storage.saveCandidate(visibleCandidate, { idempotencyKey: 'save-expired' }),
    ).resolves.toEqual({ status: 'failed', reason: 'stale' });
    expect(calls).toBe(2);
    expect(savePlace).not.toHaveBeenCalled();
    expect(listSavedPlaces).not.toHaveBeenCalled();
  });

  it('rejects a save with a pre-aborted signal before any save write', async () => {
    const opened = openStore();
    databases.push(opened.database);
    let savedRequest = false;
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
      savedRequest = true;
      return Promise.resolve(
        json(
          {
            schemaVersion: 'v1',
            requestId: stringField(body, 'requestId'),
            candidateId: stringField(body, 'candidateId'),
            savedPlaceRef: 'saved-ref-cancelled',
          },
          201,
        ),
      );
    };
    const runtime = runtimeFor(fetchImpl, {
      sqlite: opened.store,
      referenceRetentionFor: () => referenceRetention,
    });
    const binding = runtime.binding;
    if (binding === null || binding.storage === undefined) {
      throw new Error('formal storage should be connected');
    }
    await binding.controller.createThread(binding.requests.createThread());
    await binding.controller.search(searchRequestFor(binding));
    const controller = new AbortController();
    controller.abort();
    await expect(
      binding.storage.saveCandidate(visibleCandidate, {
        idempotencyKey: 'save-cancelled',
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: 'failed', reason: 'aborted' });
    expect(savedRequest).toBe(false);
    expect(opened.store.listSavedPlaces()).toHaveLength(0);
  });
});
