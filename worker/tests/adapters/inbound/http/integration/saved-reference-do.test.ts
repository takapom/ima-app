import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from '@worker/entrypoints/cloudflare/thread-do';
import {
  createOwnerSavedReferenceRpc,
  savedReferenceOwnerName,
  type SavedReferenceNamespace,
} from '@worker/infrastructure/adapters/outbound/persistence/saved-references/saved-reference-do';

type TestEnv = Cloudflare.Env & {
  readonly SAVED_REFERENCES: SavedReferenceNamespace;
  readonly THREADS: DurableObjectNamespace<ThreadDO>;
};

const testEnv = (value: typeof env): TestEnv => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('SAVED_REFERENCES' in value) ||
    !('THREADS' in value)
  ) {
    throw new Error('M16_SAVED_REFERENCE_BINDING_MISSING');
  }
  return value as TestEnv;
};

const ownerFor = (label: string): string => `m16-c2a-${label}-${crypto.randomUUID()}`;

const registration = (recordRef: string) => ({
  provider: 'google_places',
  recordRef,
});

const savedNamespace = (): SavedReferenceNamespace => testEnv(env).SAVED_REFERENCES;

describe('M16 owner-sharded SavedReferenceDO', () => {
  it('binds an owner once and rejects uninitialized or foreign operations', async () => {
    const owner = ownerFor('bind');
    const otherOwner = ownerFor('foreign');
    const stub = savedNamespace().getByName(savedReferenceOwnerName(owner));

    await expect(stub.read(owner, 'saved-before-init')).resolves.toEqual({
      ok: false,
      code: 'OWNER_NOT_INITIALIZED',
    });
    await expect(stub.initialize(owner)).resolves.toEqual({ ok: true, created: true });
    await expect(stub.initialize(owner)).resolves.toEqual({ ok: true, created: false });
    await expect(stub.initialize(otherOwner)).resolves.toEqual({
      ok: false,
      code: 'OWNER_CONFLICT',
    });
  });

  it('uses an owner-derived shard and restores identity after DO eviction', async () => {
    const owner = ownerFor('restore');
    const rpc = createOwnerSavedReferenceRpc(savedNamespace(), owner);
    const stub = savedNamespace().getByName(savedReferenceOwnerName(owner));
    await expect(rpc.initialize()).resolves.toEqual({ ok: true, created: true });
    const created = await rpc.register(registration('ChIJm16-c2a-restore'));
    expect(created).toMatchObject({ ok: true, created: true });
    if (!created.ok) throw new Error('M16_SAVED_REFERENCE_CREATE_FAILED');

    await evictDurableObject(stub);
    const coldRpc = createOwnerSavedReferenceRpc(savedNamespace(), owner);
    await expect(coldRpc.initialize()).resolves.toEqual({ ok: true, created: false });
    await expect(coldRpc.read(created.reference.savedPlaceRef)).resolves.toEqual({
      ok: true,
      reference: created.reference,
    });
  });

  it('deletes and re-registers through the DO without reviving the old ref', async () => {
    const owner = ownerFor('delete-reregister');
    const rpc = createOwnerSavedReferenceRpc(savedNamespace(), owner);
    await rpc.initialize();
    const first = await rpc.register(registration('ChIJm16-c2a-delete-reregister'));
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error('M16_SAVED_REFERENCE_CREATE_FAILED');

    await expect(rpc.remove(first.reference.savedPlaceRef)).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    await expect(rpc.read(first.reference.savedPlaceRef)).resolves.toEqual({
      ok: true,
      reference: null,
    });
    const second = await rpc.register(registration('ChIJm16-c2a-delete-reregister'));
    expect(second).toMatchObject({ ok: true, created: true });
    if (!second.ok) throw new Error('M16_SAVED_REFERENCE_REREGISTER_FAILED');
    expect(second.reference.savedPlaceRef).not.toBe(first.reference.savedPlaceRef);
  });

  it('keeps shards independent while blocking a foreign owner on one shard', async () => {
    const ownerA = ownerFor('shard-a');
    const ownerB = ownerFor('shard-b');
    const rpcA = createOwnerSavedReferenceRpc(savedNamespace(), ownerA);
    const rpcB = createOwnerSavedReferenceRpc(savedNamespace(), ownerB);
    const stubA = savedNamespace().getByName(savedReferenceOwnerName(ownerA));
    await rpcA.initialize();
    await rpcB.initialize();

    const [a, b] = await Promise.all([
      rpcA.register(registration('ChIJm16-c2a-shared')),
      rpcB.register(registration('ChIJm16-c2a-shared')),
    ]);
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toMatchObject({ ok: true, created: true });
    if (!a.ok || !b.ok) throw new Error('M16_SAVED_REFERENCE_SHARD_SETUP_FAILED');
    expect(a.reference.savedPlaceRef).not.toBe(b.reference.savedPlaceRef);

    await expect(stubA.read(ownerB, a.reference.savedPlaceRef)).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    await expect(stubA.remove(ownerB, a.reference.savedPlaceRef)).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    await expect(stubA.register(ownerB, registration('ChIJm16-c2a-foreign'))).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('does not couple saved references to ThreadDO deletion', async () => {
    const owner = ownerFor('thread-delete');
    const threadId = `m16-c2a-thread-${crypto.randomUUID()}`;
    const thread = testEnv(env).THREADS.getByName(threadId);
    const rpc = createOwnerSavedReferenceRpc(savedNamespace(), owner);
    await expect(thread.initialize(owner, threadId)).resolves.toMatchObject({ ok: true });
    await rpc.initialize();
    const created = await rpc.register(registration('ChIJm16-c2a-thread-delete'));
    if (!created.ok) throw new Error('M16_SAVED_REFERENCE_CREATE_FAILED');

    await expect(thread.deleteThread(owner, null, 1, `delete-${threadId}`)).resolves.toEqual({
      ok: true,
    });
    await evictDurableObject(thread);
    await expect(
      createOwnerSavedReferenceRpc(savedNamespace(), owner).read(created.reference.savedPlaceRef),
    ).resolves.toEqual({ ok: true, reference: created.reference });
  });

  it('rejects payload fields at the RPC boundary before writing a row', async () => {
    const owner = ownerFor('payload');
    const rpc = createOwnerSavedReferenceRpc(savedNamespace(), owner);
    const stub = savedNamespace().getByName(savedReferenceOwnerName(owner));
    await rpc.initialize();
    await expect(
      rpc.register({
        ...registration('ChIJm16-c2a-payload'),
        name: 'provider canary',
        location: { lat: 35, lng: 139 },
        observations: [{ value: 'provider payload' }],
      }),
    ).resolves.toEqual({ ok: false, code: 'INVALID_INPUT' });
    const count = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ readonly count: number }>(
            'SELECT COUNT(*) AS count FROM m16_saved_place_reference',
          )
          .toArray()[0]?.count,
    );
    expect(count).toBe(0);
  });

  it('serializes concurrent owner binding so only one owner wins', async () => {
    const owner = ownerFor('race-a');
    const otherOwner = ownerFor('race-b');
    const stub = savedNamespace().getByName(savedReferenceOwnerName(owner));
    const outcomes = await Promise.all([stub.initialize(owner), stub.initialize(otherOwner)]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      { ok: false, code: 'OWNER_CONFLICT' },
    ]);
  });

  it('rejects an invalid owner-derived namespace key before RPC creation', () => {
    expect(() => createOwnerSavedReferenceRpc(savedNamespace(), 'owner with spaces')).toThrow(
      'INVALID_OWNER_SCOPE',
    );
  });
});
