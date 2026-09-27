import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import { createSqlPhotoReferenceStore } from '@worker/adapters/out/persistence/photo/sql-reference-store';

it('restores photo handles after reconstruction, isolates owners/devices and deletes at expiry', async () => {
  const hasThreads = (value: unknown): value is { THREADS: DurableObjectNamespace<ThreadDO> } =>
    typeof value === 'object' && value !== null && 'THREADS' in value;
  if (!hasThreads(env)) throw new Error('THREADS_MISSING');
  const stub = env.THREADS.getByName(`photo-sql-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (_instance, state) => {
    const now = '2026-09-22T10:00:00Z';
    const expiresAt = '2026-09-22T10:30:00Z';
    const record = {
      handle: 'h'.repeat(22),
      ownerScopeRef: 'owner',
      threadId: 'thread',
      deviceIdHash: 'd'.repeat(22),
      photoRef: 'places/shop/photos/photo',
      expiresAt,
    };
    const store = createSqlPhotoReferenceStore(state.storage);
    await store.put(record, now);
    await expect(store.put(record, now)).rejects.toThrow('REFERENCE_CONFLICT');
    const restored = createSqlPhotoReferenceStore(state.storage);
    expect(await restored.get(record.handle, now, record)).toEqual(record);
    expect(
      await restored.get(record.handle, now, { ...record, ownerScopeRef: 'other' }),
    ).toBeUndefined();
    expect(
      await restored.get(record.handle, now, { ...record, deviceIdHash: 'x'.repeat(22) }),
    ).toBeUndefined();
    expect(restored.nextAlarm()).toBe(Date.parse(expiresAt));
    restored.purge(expiresAt);
    expect(await restored.get(record.handle, expiresAt, record)).toBeUndefined();
    expect(state.storage.sql.exec('SELECT * FROM photo_references').toArray()).toEqual([]);
  });
});
