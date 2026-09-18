import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { PublicErrorSchema } from '@ima/contracts';
import type { BoundaryFailure } from '@worker/infrastructure/adapters/inbound/http/errors';
import { routeRequest } from '@worker/infrastructure/adapters/inbound/http/router';
import {
  eventsInput,
  lifecycleInput,
  makeHarness,
  makeRequest,
  candidateId,
  prefsWriteInput,
  requestId,
  searchInput,
  savedPlaceRef,
  threadId,
  turnInput,
} from './router-fixtures';

const readError = async (response: Response) => {
  const parsed = v.safeParse(PublicErrorSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('expected public error');
  return parsed.output;
};

describe('HTTP router boundary', () => {
  it('dispatches every public RouteContracts entry to the matching injected boundary', async () => {
    const cases = [
      {
        name: 'search',
        path: '/v1/search',
        method: 'POST',
        json: searchInput,
        status: 200,
        expected: { kind: 'search', input: { threadId, requestId } },
      },
      {
        name: 'photo',
        path: '/v1/photos/photo-token-1',
        method: 'GET',
        status: 200,
        expected: undefined,
      },
      {
        name: 'prefs-read',
        path: '/v1/prefs',
        method: 'GET',
        status: 200,
        expected: { kind: 'prefs_read' },
      },
      {
        name: 'prefs-write',
        path: '/v1/prefs',
        method: 'PUT',
        json: prefsWriteInput,
        status: 200,
        expected: { kind: 'prefs_write', input: { requestId } },
      },
      {
        name: 'saved-list',
        path: '/v1/saved',
        method: 'GET',
        status: 200,
        expected: { kind: 'saved_reference_list' },
      },
      {
        name: 'saved',
        path: '/v1/saved/saved-1/refresh',
        method: 'GET',
        status: 200,
        expected: { kind: 'saved_reference_refresh', path: { savedPlaceRef: 'saved-1' } },
      },
      {
        name: 'events',
        path: '/v1/events',
        method: 'POST',
        json: eventsInput,
        status: 204,
        expected: undefined,
      },
      {
        name: 'create',
        path: '/v1/threads',
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          idempotencyKey: 'idempotency-create',
        },
        status: 201,
        expected: { kind: 'create_thread', input: { requestId } },
      },
      {
        name: 'turn',
        path: '/v1/threads/thread-1/turns',
        method: 'POST',
        json: turnInput,
        status: 200,
        expected: { kind: 'turn', path: { threadId }, input: { requestId } },
      },
      {
        name: 'saved-create',
        path: '/v1/threads/thread-1/saved',
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          candidateId,
          revision: 1,
          idempotencyKey: 'saved-create-1',
        },
        status: 201,
        expected: { kind: 'saved_reference_create', path: { threadId }, input: { requestId } },
      },
      {
        name: 'place-decide',
        path: '/v1/threads/thread-1/decided',
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          candidateId,
          revision: 1,
          idempotencyKey: 'decide-1',
        },
        status: 201,
        expected: { kind: 'place_decide', path: { threadId }, input: { requestId } },
      },
      {
        name: 'saved-delete',
        path: `/v1/saved/${savedPlaceRef}`,
        method: 'DELETE',
        json: {
          schemaVersion: 'v1',
          requestId,
          idempotencyKey: 'saved-delete-1',
        },
        status: 204,
        expected: { kind: 'saved_reference_delete', path: { savedPlaceRef }, input: { requestId } },
      },
      {
        name: 'read',
        path: '/v1/threads/thread-1',
        method: 'GET',
        status: 200,
        expected: { kind: 'read_thread', path: { threadId } },
      },
      {
        name: 'replay',
        path: '/v1/threads/thread-1/replay',
        method: 'GET',
        status: 200,
        expected: { kind: 'replay_thread', path: { threadId } },
      },
      ...(['cancel', 'resume', 'restart', 'end'] as const).map((action) => ({
        name: action,
        path: `/v1/threads/thread-1/${action}`,
        method: 'POST',
        json: lifecycleInput,
        status: 200,
        expected: { kind: 'lifecycle', action, path: { threadId }, input: { requestId } },
      })),
      {
        name: 'delete',
        path: '/v1/threads/thread-1',
        method: 'DELETE',
        json: lifecycleInput,
        status: 204,
        expected: { kind: 'delete_thread', path: { threadId }, input: { requestId } },
      },
    ];

    expect(cases).toHaveLength(19);
    for (const testCase of cases) {
      const harness = makeHarness();
      const response = await routeRequest(
        makeRequest(testCase.path, { method: testCase.method, json: testCase.json }),
        harness.config,
      );
      expect(response.status, testCase.name).toBe(testCase.status);
      if (testCase.name === 'photo') expect(harness.calls.photo).toBe(1);
      else if (testCase.name === 'events') expect(harness.calls.events).toBe(1);
      else expect(harness.calls.application).toBe(1);
      if (testCase.expected !== undefined) {
        const operation = harness.calls.operations[0];
        if (operation === undefined) throw new Error(`missing operation for ${testCase.name}`);
        expect(operation).toMatchObject(testCase.expected);
      }
      if (testCase.status === 204) expect(await response.text()).toBe('');
    }
  });

  it('enforces request/body IDs, strict paths and query fields before side effects', async () => {
    const mismatched = makeHarness();
    const mismatchResponse = await routeRequest(
      makeRequest('/v1/threads', {
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId: 'different-request',
          idempotencyKey: 'idempotency-3',
        },
      }),
      mismatched.config,
    );
    expect(mismatchResponse.status).toBe(400);
    expect(mismatched.calls.application).toBe(0);

    const unsupportedQueries = [
      { path: '/v1/search?debug=true', method: 'POST', json: searchInput },
      { path: '/v1/photos/photo-token-1?debug=true' },
      { path: '/v1/prefs?debug=true' },
      { path: '/v1/prefs?debug=true', method: 'PUT', json: prefsWriteInput },
      { path: '/v1/saved?debug=true' },
      { path: '/v1/saved/saved-1/refresh?debug=true' },
      { path: '/v1/events?debug=true', method: 'POST', json: eventsInput },
      {
        path: '/v1/threads?debug=true',
        method: 'POST',
        json: { schemaVersion: 'v1', requestId, idempotencyKey: 'idempotency-4' },
      },
      { path: '/v1/threads/thread-1?debug=true' },
      { path: '/v1/threads/thread-1/turns?debug=true', method: 'POST', json: turnInput },
      {
        path: '/v1/threads/thread-1/saved?debug=true',
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          candidateId,
          revision: 1,
          idempotencyKey: 'saved-create-query',
        },
      },
      {
        path: '/v1/saved/saved-1?debug=true',
        method: 'DELETE',
        json: { schemaVersion: 'v1', requestId, idempotencyKey: 'saved-delete-query' },
      },
    ];
    for (const unsupportedQuery of unsupportedQueries) {
      const harness = makeHarness();
      const { path, ...init } = unsupportedQuery;
      const response = await routeRequest(makeRequest(path, init), harness.config);
      expect(response.status, unsupportedQuery.path).toBe(400);
      expect(harness.calls.rate).toBe(0);
      expect(harness.calls.application).toBe(0);
      expect(harness.calls.photo).toBe(0);
      expect(harness.calls.events).toBe(0);
    }

    for (const path of [
      '/v1/places/candidate-1?fields=identity',
      '/v1/threads/thread-1/unknown',
      '/v1/threads/thread-1/replay/extra',
      '/v1/admin/config',
      '/v1/rpc/execute',
      '/v1/threads/thread-1/ws',
    ]) {
      const harness = makeHarness();
      const response = await routeRequest(makeRequest(path), harness.config);
      expect(response.status, path).toBe(404);
      expect(harness.calls.rate).toBe(0);
      expect(harness.calls.application).toBe(0);
      expect(harness.calls.photo).toBe(0);
      expect(harness.calls.events).toBe(0);
    }

    const upgrade = makeHarness();
    const upgradeResponse = await routeRequest(
      makeRequest('/v1/threads/thread-1', { headers: { upgrade: 'websocket' } }),
      upgrade.config,
    );
    expect(upgradeResponse.status).toBe(404);
    expect(upgrade.calls.rate).toBe(0);
  });

  it('checks each resource scope independently of owner authentication', async () => {
    const search = makeHarness({ denyKind: 'thread' });
    const searchResponse = await routeRequest(
      makeRequest('/v1/search', { method: 'POST', json: searchInput }),
      search.config,
    );
    expect(searchResponse.status).toBe(403);
    expect(search.calls.ownership).toEqual(['thread']);
    expect(search.calls.application).toBe(0);

    const saved = makeHarness({ denyKind: 'saved_reference' });
    const savedResponse = await routeRequest(
      makeRequest('/v1/saved/saved-1/refresh'),
      saved.config,
    );
    expect(savedResponse.status).toBe(403);
    expect(saved.calls.ownership).toEqual(['saved_reference']);
    expect(saved.calls.application).toBe(0);

    const photo = makeHarness({ denyKind: 'photo' });
    const photoResponse = await routeRequest(makeRequest('/v1/photos/photo-token-1'), photo.config);
    expect(photoResponse.status).toBe(403);
    expect(photo.calls.photo).toBe(0);

    const events = makeHarness({ denyKind: 'thread' });
    const eventsResponse = await routeRequest(
      makeRequest('/v1/events', { method: 'POST', json: eventsInput }),
      events.config,
    );
    expect(eventsResponse.status).toBe(403);
    expect(events.calls.events).toBe(0);

    const savedCreate = makeHarness({ denyKind: 'thread' });
    const savedCreateResponse = await routeRequest(
      makeRequest('/v1/threads/thread-1/saved', {
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          candidateId,
          revision: 1,
          idempotencyKey: 'saved-create-denied',
        },
      }),
      savedCreate.config,
    );
    expect(savedCreateResponse.status).toBe(403);
    expect(savedCreate.calls.application).toBe(0);

    const prefsRead = makeHarness({ denyKind: 'thread' });
    const prefsReadResponse = await routeRequest(makeRequest('/v1/prefs'), prefsRead.config);
    expect(prefsReadResponse.status).toBe(200);
    expect(prefsRead.calls.ownership).toEqual([]);
    expect(prefsRead.calls.application).toBe(1);

    const prefsWrite = makeHarness({ denyKind: 'saved_reference' });
    const prefsWriteResponse = await routeRequest(
      makeRequest('/v1/prefs', { method: 'PUT', json: prefsWriteInput }),
      prefsWrite.config,
    );
    expect(prefsWriteResponse.status).toBe(200);
    expect(prefsWrite.calls.ownership).toEqual([]);
    expect(prefsWrite.calls.application).toBe(1);

    const savedList = makeHarness({ denyKind: 'saved_reference' });
    const savedListResponse = await routeRequest(makeRequest('/v1/saved'), savedList.config);
    expect(savedListResponse.status).toBe(200);
    expect(savedList.calls.ownership).toEqual([]);
    expect(savedList.calls.application).toBe(1);

    const foreignSavedDelete = makeHarness({ denyKind: 'saved_reference' });
    const foreignSavedDeleteResponse = await routeRequest(
      makeRequest(`/v1/saved/${savedPlaceRef}`, {
        method: 'DELETE',
        json: { schemaVersion: 'v1', requestId, idempotencyKey: 'saved-delete-foreign' },
      }),
      foreignSavedDelete.config,
    );
    expect(foreignSavedDeleteResponse.status).toBe(204);
    expect(foreignSavedDelete.calls.ownership).toEqual([]);
    expect(foreignSavedDelete.calls.application).toBe(1);
  });

  it('maps rate and typed domain failures to fixed public envelopes', async () => {
    const rate = makeHarness({ rate: { allowed: false, retryAfterSeconds: 17 } });
    const rateResponse = await routeRequest(makeRequest('/v1/threads/thread-1'), rate.config);
    expect(rateResponse.status).toBe(429);
    expect(rateResponse.headers.get('retry-after')).toBe('17');
    expect(rate.calls.application).toBe(0);
    expect(rate.calls.photo).toBe(0);
    expect(rate.calls.events).toBe(0);

    const failures: Array<{ failure: BoundaryFailure; status: number; code: string }> = [
      { failure: { status: 403, code: 'FORBIDDEN' }, status: 403, code: 'FORBIDDEN' },
      { failure: { status: 409, code: 'CONFLICT' }, status: 409, code: 'CONFLICT' },
      { failure: { status: 410, code: 'EXPIRED' }, status: 410, code: 'EXPIRED' },
      {
        failure: { status: 422, code: 'CONSTRAINT_VIOLATION' },
        status: 422,
        code: 'CONSTRAINT_VIOLATION',
      },
      {
        failure: { status: 502, code: 'PROVIDER_UNAVAILABLE' },
        status: 502,
        code: 'PROVIDER_UNAVAILABLE',
      },
      { failure: { status: 504, code: 'TIMEOUT' }, status: 504, code: 'TIMEOUT' },
    ];
    for (const testCase of failures) {
      const harness = makeHarness({ applicationFailure: testCase.failure });
      const response = await routeRequest(makeRequest('/v1/threads/thread-1'), harness.config);
      expect(response.status, testCase.code).toBe(testCase.status);
      const error = await readError(response);
      expect(error.code, testCase.code).toBe(testCase.code);
      expect(error.message).not.toContain('secret');
    }

    const rawFailure = makeHarness({ rawApplicationError: true });
    const rawResponse = await routeRequest(makeRequest('/v1/threads/thread-1'), rawFailure.config);
    expect(rawResponse.status).toBe(500);
    expect(await rawResponse.text()).not.toContain('provider secret');
  });

  it('returns binary photo data with an HTTP-date expiry and rejects expired data', async () => {
    const harness = makeHarness();
    const response = await routeRequest(makeRequest('/v1/photos/photo-token-1'), harness.config);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('expires')).toBe('Thu, 10 Sep 2026 12:00:00 GMT');
    expect(response.headers.get('expires')).not.toContain('2026-09-10T');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);

    const expired = makeHarness({ photoExpiresAt: '2026-09-09T11:59:59Z' });
    const expiredResponse = await routeRequest(
      makeRequest('/v1/photos/photo-token-1'),
      expired.config,
    );
    expect(expiredResponse.status).toBe(410);
    expect(expired.calls.photo).toBe(1);

    const staleDuringRead = makeHarness({
      nowValues: ['2026-09-09T11:59:00Z', '2026-09-09T12:00:01Z'],
      photoExpiresAt: '2026-09-09T12:00:00Z',
      photoDelay: true,
    });
    const staleDuringReadResponse = await routeRequest(
      makeRequest('/v1/photos/photo-token-1'),
      staleDuringRead.config,
    );
    expect(staleDuringReadResponse.status).toBe(410);
    expect(staleDuringRead.calls.photo).toBe(1);
  });

  it('rejects an invalid server clock before any paid or injected handler work', async () => {
    const harness = makeHarness({ serverNow: 'not-an-iso-clock' });
    const response = await routeRequest(makeRequest('/v1/threads/thread-1'), harness.config);
    expect(response.status).toBe(500);
    const error = await readError(response);
    expect(error.code).toBe('INTERNAL');
    expect(harness.calls.rate).toBe(0);
    expect(harness.calls.application).toBe(0);
    expect(harness.calls.photo).toBe(0);
    expect(harness.calls.events).toBe(0);
  });

  it('stops all injected work when the request is already cancelled and keeps credentials out of context', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const response = await routeRequest(
      makeRequest('/v1/threads/thread-1', { signal: controller.signal }),
      harness.config,
    );
    expect(response.status).toBe(409);
    expect(harness.calls.rate).toBe(0);
    expect(harness.calls.application).toBe(0);
    expect(harness.calls.photo).toBe(0);
    expect(harness.calls.events).toBe(0);

    const successful = makeHarness();
    const successfulResponse = await routeRequest(
      makeRequest('/v1/threads/thread-1'),
      successful.config,
    );
    expect(successfulResponse.status).toBe(200);
    const context = successful.calls.contexts[0];
    if (context === undefined) throw new Error('expected handler context');
    expect('ownerCredential' in context).toBe(false);
    expect(context.ownerScopeRef).not.toContain('A'.repeat(43));
  });
});
