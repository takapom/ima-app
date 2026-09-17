import { env, evictDurableObject, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { RateLimitDO, ThreadDO } from '../../../src/thread-do';

const APP_TOKEN = 'test-app-token';
const OWNER_A = 'A'.repeat(42) + 'E';
const OWNER_B = 'B'.repeat(42) + 'E';

type JsonRecord = Record<string, unknown>;

type TestEnv = Cloudflare.Env & {
  THREADS: DurableObjectNamespace<ThreadDO>;
  RATE_LIMITS: DurableObjectNamespace<RateLimitDO>;
};

const hasBindings = (value: unknown): value is TestEnv =>
  typeof value === 'object' && value !== null && 'THREADS' in value && 'RATE_LIMITS' in value;

const headers = (ownerCredential: string, requestId: string, deviceId: string): HeadersInit => ({
  'content-type': 'application/json',
  'x-app-token': APP_TOKEN,
  'x-device-id': deviceId,
  'x-ima-owner-credential': ownerCredential,
  'x-ima-request-id': requestId,
  'x-app-version': 'm22-create-idempotency-test',
});

const create = async (
  ownerCredential: string,
  requestId: string,
  idempotencyKey: string,
): Promise<Response> =>
  SELF.fetch('https://ima.test/v1/threads', {
    method: 'POST',
    headers: headers(ownerCredential, requestId, `device-${requestId}`),
    body: JSON.stringify({ schemaVersion: 'v1', requestId, idempotencyKey }),
  });

const json = async (response: Response): Promise<JsonRecord> => {
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected JSON object');
  }
  return value as JsonRecord;
};

describe('create thread HTTP idempotency', () => {
  it('reuses one owner/key thread and does not reactivate it after deletion', async () => {
    if (!hasBindings(env)) throw new Error('M05_THREAD_BINDING_MISSING');
    const key = `create-idempotent-${crypto.randomUUID()}`;
    const firstRequestId = `create-first-${crypto.randomUUID()}`;
    const first = await create(OWNER_A, firstRequestId, key);
    expect(first.status).toBe(201);
    const firstBody = await json(first);
    if (typeof firstBody.threadId !== 'string') throw new Error('missing first thread ID');

    const retryRequestId = `create-retry-${crypto.randomUUID()}`;
    const retry = await create(OWNER_A, retryRequestId, key);
    expect(retry.status).toBe(201);
    const retryBody = await json(retry);
    expect(retryBody.threadId).toBe(firstBody.threadId);
    expect(retryBody.requestId).toBe(retryRequestId);
    expect(retryBody.revision).toBe(firstBody.revision);

    const otherOwner = await create(OWNER_B, `create-other-${crypto.randomUUID()}`, key);
    expect(otherOwner.status).toBe(201);
    const otherOwnerBody = await json(otherOwner);
    expect(otherOwnerBody.threadId).not.toBe(firstBody.threadId);

    const expiredKey = `create-expired-${crypto.randomUUID()}`;
    const expiredFirst = await create(
      OWNER_A,
      `create-expired-first-${crypto.randomUUID()}`,
      expiredKey,
    );
    expect(expiredFirst.status).toBe(201);
    const expiredFirstBody = await json(expiredFirst);
    if (typeof expiredFirstBody.threadId !== 'string') throw new Error('missing expired thread ID');
    const expiredStub = env.THREADS.getByName(expiredFirstBody.threadId);
    await runInDurableObject(expiredStub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE runtime_retention_anchor SET thread_created_at = ? WHERE singleton = 1',
        '2020-01-01T00:00:00.000Z',
      );
    });
    await evictDurableObject(expiredStub);
    const afterExpiry = await create(
      OWNER_A,
      `create-expired-retry-${crypto.randomUUID()}`,
      expiredKey,
    );
    expect(afterExpiry.status).toBe(404);
    expect((await json(afterExpiry)).code).toBe('NOT_FOUND');

    const cancelRequestId = `cancel-${crypto.randomUUID()}`;
    const cancelled = await SELF.fetch(`https://ima.test/v1/threads/${firstBody.threadId}/cancel`, {
      method: 'POST',
      headers: headers(OWNER_A, cancelRequestId, `device-${cancelRequestId}`),
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: cancelRequestId,
        turnId: null,
        revision: firstBody.revision,
        idempotencyKey: `cancel-${crypto.randomUUID()}`,
      }),
    });
    expect(cancelled.status).toBe(200);
    const cancelledBody = await json(cancelled);

    const afterLifecycle = await create(OWNER_A, `create-after-cancel-${crypto.randomUUID()}`, key);
    expect(afterLifecycle.status).toBe(409);
    expect((await json(afterLifecycle)).code).toBe('CONFLICT');

    const deleteRequestId = `delete-${crypto.randomUUID()}`;
    const deleted = await SELF.fetch(`https://ima.test/v1/threads/${firstBody.threadId}`, {
      method: 'DELETE',
      headers: headers(OWNER_A, deleteRequestId, `device-${deleteRequestId}`),
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: deleteRequestId,
        turnId: null,
        revision: cancelledBody.revision,
        idempotencyKey: `delete-${crypto.randomUUID()}`,
      }),
    });
    expect(deleted.status).toBe(204);

    const afterDelete = await create(OWNER_A, `create-after-delete-${crypto.randomUUID()}`, key);
    expect(afterDelete.status).toBe(404);
  });
});
