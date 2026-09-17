import { describe, expect, it } from 'vitest';
import { createThreadPhotoReferences } from '@worker/adapters/outbound/persistence/photo/thread-references';
import { createMemoryPhotoReferenceStore } from '@worker/adapters/outbound/persistence/photo/reference-store';
import type {
  PhotoReferenceLookupScope,
  PhotoReferenceRecord,
  PhotoReferenceStoreWithClear,
} from '@worker/runtime/ports/photo';

const NOW = '2026-09-10T12:00:00.000Z';
const HANDLE = 'h'.repeat(22);
const DEVICE_HASH = 'd'.repeat(22);

const recordFor = (expiresAt = '2026-09-10T12:10:00.000Z'): PhotoReferenceRecord => ({
  handle: HANDLE,
  ownerScopeRef: 'owner-photo',
  threadId: 'thread-photo',
  deviceIdHash: DEVICE_HASH,
  photoRef: 'places/ChIJfixture/photos/A1B2C3',
  expiresAt,
});

describe('ThreadPhotoReferences', () => {
  it('binds references to the live owner/thread and rechecks the server clock', async () => {
    let serverNow = NOW;
    const references = createThreadPhotoReferences({
      clock: () => serverNow,
      binding: () => ({
        thread_id: 'thread-photo',
        owner_scope_ref: 'owner-photo',
        deleted: 0,
      }),
    });

    await expect(references.putPhotoReference('owner-photo', recordFor(), NOW)).resolves.toEqual({
      ok: true,
    });
    await expect(
      references.getPhotoReference('owner-photo', HANDLE, DEVICE_HASH, NOW),
    ).resolves.toMatchObject({ ok: true, record: recordFor() });

    serverNow = '2026-09-10T12:11:00.000Z';
    await expect(
      references.getPhotoReference('owner-photo', HANDLE, DEVICE_HASH, NOW),
    ).resolves.toEqual({ ok: true, record: null });
  });

  it('does not let a caller or stale binding bypass scope and deletion checks', async () => {
    let deleted = false;
    const references = createThreadPhotoReferences({
      clock: () => NOW,
      binding: () => ({
        thread_id: 'thread-photo',
        owner_scope_ref: 'owner-photo',
        deleted: deleted ? 1 : 0,
      }),
    });
    await expect(references.putPhotoReference('other-owner', recordFor(), NOW)).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });

    deleted = true;
    await expect(
      references.getPhotoReference('owner-photo', HANDLE, DEVICE_HASH, NOW),
    ).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('rejects expired and overlong lifetimes before registering a reference', async () => {
    const references = createThreadPhotoReferences({
      clock: () => NOW,
      binding: () => ({
        thread_id: 'thread-photo',
        owner_scope_ref: 'owner-photo',
        deleted: 0,
      }),
    });
    await expect(
      references.putPhotoReference('owner-photo', recordFor('2026-09-10T11:59:59.000Z'), NOW),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
    await expect(
      references.putPhotoReference('owner-photo', recordFor('2026-09-10T12:31:00.000Z'), NOW),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
  });

  it('clears a delayed registration when the binding is deleted before completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = createMemoryPhotoReferenceStore();
    const delayedStore: PhotoReferenceStoreWithClear = {
      put(record, requestedNow) {
        return gate.then(() => base.put(record, requestedNow));
      },
      get(handle, requestedNow, scope?: PhotoReferenceLookupScope) {
        return base.get(handle, requestedNow, scope);
      },
      clear() {
        return base.clear();
      },
    };
    let deleted = false;
    const references = createThreadPhotoReferences({
      store: delayedStore,
      clock: () => NOW,
      binding: () => ({
        thread_id: 'thread-photo',
        owner_scope_ref: 'owner-photo',
        deleted: deleted ? 1 : 0,
      }),
    });

    const pending = references.putPhotoReference('owner-photo', recordFor(), NOW);
    await Promise.resolve();
    deleted = true;
    release();
    await expect(pending).resolves.toEqual({ ok: false, code: 'NOT_FOUND' });
    await expect(base.get(HANDLE, NOW)).resolves.toBeUndefined();
  });
});
