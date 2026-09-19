import { env, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import type { PhotoReferenceRecord } from '@worker/runtime/ports/photo';

type PhotoTestEnv = Cloudflare.Env & {
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
};

const hasPhotoBinding = (value: typeof env): value is PhotoTestEnv =>
  typeof value === 'object' && value !== null && 'THREADS' in value;

const photoEnv = (value: typeof env): PhotoTestEnv => {
  if (!hasPhotoBinding(value)) throw new Error('M15_THREAD_BINDING_MISSING');
  return value;
};

const referenceFor = (
  threadId: string,
  ownerScopeRef: string,
  expiresAt: string,
): PhotoReferenceRecord => ({
  handle: 'h'.repeat(22),
  ownerScopeRef,
  threadId,
  deviceIdHash: 'd'.repeat(22),
  photoRef: 'places/ChIJfixture/photos/A1B2C3',
  expiresAt,
});

describe('M15 ThreadDO photo reference RPC', () => {
  it('enforces owner/device scope and clears references on delete', async () => {
    const threadId = `m15-photo-rpc-${crypto.randomUUID()}`;
    const owner = `m15-owner-${crypto.randomUUID()}`;
    const stub = photoEnv(env).THREADS.getByName(threadId);
    const requestedNow = new Date(0).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const record = referenceFor(threadId, owner, expiresAt);

    await expect(stub.initialize(owner, threadId)).resolves.toMatchObject({ ok: true });
    await expect(stub.putPhotoReference(owner, record, requestedNow)).resolves.toEqual({
      ok: true,
    });
    await expect(
      stub.getPhotoReference(owner, record.handle, record.deviceIdHash, requestedNow),
    ).resolves.toEqual({ ok: true, record });
    await expect(
      stub.getPhotoReference(owner, record.handle, 'x'.repeat(22), requestedNow),
    ).resolves.toEqual({ ok: true, record: null });
    await expect(
      stub.getPhotoReference('other-owner', record.handle, record.deviceIdHash, requestedNow),
    ).resolves.toEqual({ ok: false, code: 'FORBIDDEN' });

    await expect(stub.deleteThread(owner, null, 1, `delete-${threadId}`)).resolves.toEqual({
      ok: true,
    });
    await expect(
      stub.getPhotoReference(owner, record.handle, record.deviceIdHash, requestedNow),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    await expect(stub.putPhotoReference(owner, record, requestedNow)).resolves.toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });

    await evictDurableObject(stub);
    const cold = photoEnv(env).THREADS.getByName(threadId);
    await expect(
      cold.getPhotoReference(owner, record.handle, record.deviceIdHash, requestedNow),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('rejects an expired record even when the caller supplies an old clock', async () => {
    const threadId = `m15-photo-expired-${crypto.randomUUID()}`;
    const owner = `m15-owner-${crypto.randomUUID()}`;
    const stub = photoEnv(env).THREADS.getByName(threadId);
    const requestedNow = new Date(0).toISOString();

    await expect(stub.initialize(owner, threadId)).resolves.toMatchObject({ ok: true });
    await expect(
      stub.putPhotoReference(
        owner,
        referenceFor(threadId, owner, new Date(Date.now() - 1_000).toISOString()),
        requestedNow,
      ),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
  });
});
