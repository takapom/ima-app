import { env, evictDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RateLimitDO, ThreadDO } from '@api/thread-do';

const APP_TOKEN = 'test-app-token';
const OWNER_A = 'A'.repeat(42) + 'E';
const OWNER_B = 'B'.repeat(42) + 'E';
const SERVER_NOW = '2026-09-10T12:00:00Z';

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type M05TestEnv = Cloudflare.Env & {
  THREADS: DurableObjectNamespace<ThreadDO>;
  RATE_LIMITS: DurableObjectNamespace<RateLimitDO>;
};

function hasM05Bindings(value: unknown): value is M05TestEnv {
  return (
    typeof value === 'object' && value !== null && 'THREADS' in value && 'RATE_LIMITS' in value
  );
}

function requestHeaders(ownerCredential: string, requestId: string, deviceId: string) {
  return {
    'content-type': 'application/json',
    'x-app-token': APP_TOKEN,
    'x-device-id': deviceId,
    'x-ima-owner-credential': ownerCredential,
    'x-ima-request-id': requestId,
    'x-app-version': 'm05-test',
  };
}

async function call(
  path: string,
  ownerCredential: string,
  requestId: string,
  deviceId: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(requestHeaders(ownerCredential, requestId, deviceId));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return SELF.fetch(`https://ima.test${path}`, { ...init, headers });
}

async function json(response: Response): Promise<JsonRecord> {
  const body: unknown = await response.json();
  if (!isJsonRecord(body)) throw new Error('expected JSON object');
  return body;
}

function createBody(requestId: string): JsonRecord {
  return { schemaVersion: 'v1', requestId, idempotencyKey: `create-${requestId}` };
}

function lifecycleBody(
  requestId: string,
  revision: number,
  idempotencyKey = `lifecycle-${requestId}`,
): JsonRecord {
  return {
    schemaVersion: 'v1',
    requestId,
    turnId: `turn-${requestId}`,
    revision,
    idempotencyKey,
  };
}

function searchBody(requestId: string, threadId: string): JsonRecord {
  return {
    schemaVersion: 'v1',
    requestId,
    threadId,
    turnId: null,
    revision: 1,
    text: '静かな店',
    clientNow: SERVER_NOW,
    location: {
      status: 'unavailable',
      lat: null,
      lng: null,
      accuracyMeters: null,
      precise: false,
      capturedAt: null,
    },
    prefs: {
      homeStationRef: null,
      maxWalkMinutes: 15,
      minimumStayMinutes: null,
      areaText: '恵比寿',
      budget: 'normal',
    },
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search',
    idempotencyKey: `search-${requestId}`,
  };
}

function eventBody(requestId: string, threadId: string): JsonRecord {
  return {
    schemaVersion: 'v1',
    requestId,
    threadId,
    event: {
      eventId: `event-${requestId}`,
      name: 'turn_completed',
      occurredAt: SERVER_NOW,
      status: 'ok',
    },
  };
}

describe('M05 Worker bootstrap and per-thread Durable Object', () => {
  it('binds ownership for create/read/lifecycle/replay/delete and rejects another owner', async () => {
    if (!hasM05Bindings(env)) throw new Error('M05_THREAD_BINDING_MISSING');
    const createRequestId = `create-${crypto.randomUUID()}`;
    const created = await call(
      '/v1/threads',
      OWNER_A,
      createRequestId,
      `device-${crypto.randomUUID()}`,
      { method: 'POST', body: JSON.stringify(createBody(createRequestId)) },
    );
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const threadId = createdBody.threadId;
    if (typeof threadId !== 'string') throw new Error('missing server thread id');

    const readRequestId = `read-${crypto.randomUUID()}`;
    const read = await call(`/v1/threads/${threadId}`, OWNER_A, readRequestId, 'device-read');
    expect(read.status).toBe(200);
    expect((await json(read)).threadId).toBe(threadId);

    const otherOwner = await call(
      `/v1/threads/${threadId}`,
      OWNER_B,
      `other-${crypto.randomUUID()}`,
      'device-other',
    );
    expect(otherOwner.status).toBe(403);

    const cancelRequestId = `cancel-${crypto.randomUUID()}`;
    const cancelInput = lifecycleBody(cancelRequestId, 1);
    const cancelled = await call(
      `/v1/threads/${threadId}/cancel`,
      OWNER_A,
      cancelRequestId,
      'device-cancel',
      {
        method: 'POST',
        body: JSON.stringify(cancelInput),
      },
    );
    expect(cancelled.status).toBe(200);
    expect((await json(cancelled)).state).toBe('cancelled');

    const cancelRetryRequestId = `cancel-retry-${crypto.randomUUID()}`;
    const cancelledRetry = await call(
      `/v1/threads/${threadId}/cancel`,
      OWNER_A,
      cancelRetryRequestId,
      'device-cancel-retry',
      {
        method: 'POST',
        body: JSON.stringify({ ...cancelInput, requestId: cancelRetryRequestId }),
      },
    );
    expect(cancelledRetry.status).toBe(200);
    expect((await json(cancelledRetry)).revision).toBe(2);

    const idempotencyConflictRequestId = `idempotency-conflict-${crypto.randomUUID()}`;
    const idempotencyConflict = await call(
      `/v1/threads/${threadId}/cancel`,
      OWNER_A,
      idempotencyConflictRequestId,
      'device-idempotency-conflict',
      {
        method: 'POST',
        body: JSON.stringify({
          ...cancelInput,
          requestId: idempotencyConflictRequestId,
          turnId: `different-turn-${idempotencyConflictRequestId}`,
        }),
      },
    );
    expect(idempotencyConflict.status).toBe(409);
    expect((await json(idempotencyConflict)).code).toBe('CONFLICT');

    const staleRequestId = `stale-${crypto.randomUUID()}`;
    const stale = await call(
      `/v1/threads/${threadId}/resume`,
      OWNER_A,
      staleRequestId,
      'device-stale',
      {
        method: 'POST',
        body: JSON.stringify(lifecycleBody(staleRequestId, 1)),
      },
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe('CONFLICT');

    const replayRequestId = `replay-${crypto.randomUUID()}`;
    const replay = await call(
      `/v1/threads/${threadId}/replay`,
      OWNER_A,
      replayRequestId,
      'device-replay',
    );
    expect(replay.status).toBe(200);
    const replayBody = await json(replay);
    expect(replayBody.threadId).toBe(threadId);
    expect(replayBody.revision).toBe(2);
    expect(replayBody.active).toBe(false);

    await evictDurableObject(env.THREADS.getByName(threadId));
    const afterEviction = await call(
      `/v1/threads/${threadId}/replay`,
      OWNER_A,
      `replay-after-eviction-${crypto.randomUUID()}`,
      'device-replay-after-eviction',
    );
    expect(afterEviction.status).toBe(200);
    expect((await json(afterEviction)).revision).toBe(2);

    const deleteByOtherOwnerRequestId = `delete-other-${crypto.randomUUID()}`;
    const deleteByOtherOwner = await call(
      `/v1/threads/${threadId}`,
      OWNER_B,
      deleteByOtherOwnerRequestId,
      'device-delete-other',
      {
        method: 'DELETE',
        body: JSON.stringify(lifecycleBody(deleteByOtherOwnerRequestId, 2)),
      },
    );
    expect(deleteByOtherOwner.status).toBe(403);

    const deleteRequestId = `delete-${crypto.randomUUID()}`;
    const deleted = await call(
      `/v1/threads/${threadId}`,
      OWNER_A,
      deleteRequestId,
      'device-delete',
      {
        method: 'DELETE',
        body: JSON.stringify(lifecycleBody(deleteRequestId, 2)),
      },
    );
    expect(deleted.status).toBe(204);

    const deleteRetryRequestId = `delete-retry-${crypto.randomUUID()}`;
    const deletedRetry = await call(
      `/v1/threads/${threadId}`,
      OWNER_A,
      deleteRetryRequestId,
      'device-delete-retry',
      {
        method: 'DELETE',
        body: JSON.stringify({
          ...lifecycleBody(deleteRequestId, 2),
          requestId: deleteRetryRequestId,
        }),
      },
    );
    expect(deletedRetry.status).toBe(204);

    const afterDelete = await call(
      `/v1/threads/${threadId}`,
      OWNER_A,
      `after-delete-${crypto.randomUUID()}`,
      'device-after-delete',
    );
    expect(afterDelete.status).toBe(404);
  });

  it('keeps provider and unknown-resource paths explicit instead of returning fixture success', async () => {
    const createRequestId = `provider-create-${crypto.randomUUID()}`;
    const created = await call(
      '/v1/threads',
      OWNER_A,
      createRequestId,
      `device-${crypto.randomUUID()}`,
      { method: 'POST', body: JSON.stringify(createBody(createRequestId)) },
    );
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const threadId = createdBody.threadId;
    if (typeof threadId !== 'string') throw new Error('missing server thread id');

    const searchRequestId = `search-${crypto.randomUUID()}`;
    const search = await call('/v1/search', OWNER_A, searchRequestId, 'device-search', {
      method: 'POST',
      body: JSON.stringify(searchBody(searchRequestId, threadId)),
    });
    expect(search.status).toBe(502);
    expect((await json(search)).code).toBe('PROVIDER_UNAVAILABLE');

    const eventRequestId = `event-${crypto.randomUUID()}`;
    const events = await call('/v1/events', OWNER_A, eventRequestId, 'device-events', {
      method: 'POST',
      body: JSON.stringify(eventBody(eventRequestId, threadId)),
    });
    expect(events.status).toBe(204);

    for (const path of ['/v1/saved/unknown-saved/refresh', '/v1/photos/unknown-photo-token']) {
      const response = await call(
        path,
        OWNER_A,
        `unknown-${crypto.randomUUID()}`,
        'device-unknown',
      );
      expect(response.status, path).toBe(404);
      expect((await json(response)).code, path).toBe('NOT_FOUND');
    }
  });

  it('persists device and owner windows in a Durable Object with explicit limits', async () => {
    if (!hasM05Bindings(env)) throw new Error('M05_RATE_LIMIT_BINDING_MISSING');
    const namespace = env.RATE_LIMITS;
    const name = `rate-${crypto.randomUUID()}`;
    const limiter = namespace.getByName(name);
    const config = { windowMs: 60_000, devicePerWindow: 1, ownerPerWindow: 2 };

    const first = await limiter.check({
      ownerScopeRef: 'owner-rate',
      deviceId: 'device-rate-a',
      route: 'test',
      config,
    });
    expect(first).toEqual({ allowed: true, retryAfterSeconds: null });

    const deviceLimited = await limiter.check({
      ownerScopeRef: 'owner-rate',
      deviceId: 'device-rate-a',
      route: 'test',
      config,
    });
    expect(deviceLimited.allowed).toBe(false);
    if (deviceLimited.allowed) throw new Error('expected device rate limit');
    expect(deviceLimited.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    const secondDevice = await limiter.check({
      ownerScopeRef: 'owner-rate',
      deviceId: 'device-rate-b',
      route: 'test',
      config,
    });
    expect(secondDevice).toEqual({ allowed: true, retryAfterSeconds: null });

    const ownerLimited = await limiter.check({
      ownerScopeRef: 'owner-rate',
      deviceId: 'device-rate-c',
      route: 'test',
      config,
    });
    expect(ownerLimited.allowed).toBe(false);
    if (ownerLimited.allowed) throw new Error('expected owner rate limit');
    expect(ownerLimited.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    await evictDurableObject(limiter);
    const ownerLimitedAfterEviction = await limiter.check({
      ownerScopeRef: 'owner-rate',
      deviceId: 'device-rate-d',
      route: 'test',
      config,
    });
    expect(ownerLimitedAfterEviction.allowed).toBe(false);
  });
});
