import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ThreadDO } from '../../../src/thread-do';
import {
  createDurableSavedReferenceStore,
  type DurableSavedReferenceStore,
  type SavedReferenceIdFactory,
} from '../../../src/saved-references/store';

const OWNER_A = `m16-owner-a-${'a'.repeat(20)}`;
const OWNER_B = `m16-owner-b-${'b'.repeat(20)}`;
const TABLE_NAME = 'm16_saved_place_reference';
const USED_REF_TABLE_NAME = 'm16_saved_place_reference_used';

type TestEnv = Cloudflare.Env & { readonly THREADS: DurableObjectNamespace<ThreadDO> };

const testEnv = (value: typeof env): TestEnv => {
  if (typeof value !== 'object' || value === null || !('THREADS' in value)) {
    throw new Error('M16_THREAD_BINDING_MISSING');
  }
  return value as TestEnv;
};

const registration = (ownerScopeRef: string, recordRef: string) => ({
  ownerScopeRef,
  provider: 'google_places',
  recordRef,
});

const idsFor = (...refs: readonly string[]): SavedReferenceIdFactory => {
  let index = 0;
  return {
    nextSavedPlaceRef: () => {
      const ref = refs[index];
      index += 1;
      return ref ?? `saved-overflow-${index}`;
    },
  };
};

const withStore = async <T>(
  stub: DurableObjectStub<ThreadDO>,
  ids: SavedReferenceIdFactory,
  work: (store: DurableSavedReferenceStore, state: DurableObjectState) => T,
): Promise<T> =>
  runInDurableObject(stub, (_instance, state) =>
    work(createDurableSavedReferenceStore(state.storage, ids), state),
  );

const newThread = (
  label: string,
): {
  readonly threadId: string;
  readonly stub: DurableObjectStub<ThreadDO>;
} => {
  const threadId = `m16-saved-${label}-${crypto.randomUUID()}`;
  return { threadId, stub: testEnv(env).THREADS.getByName(threadId) };
};

describe('M16 durable saved reference store', () => {
  it('persists only the owner-scoped identity and restores it after DO eviction', async () => {
    const { threadId, stub } = newThread('eviction');
    const input = registration(OWNER_A, 'ChIJm16eviction');
    const created = await withStore(stub, idsFor('saved-eviction'), (store, state) => {
      const result = store.register(input);
      const columns = state.storage.sql
        .exec<{ readonly name: string }>(`PRAGMA table_info('${TABLE_NAME}')`)
        .toArray()
        .map((row) => row.name);
      const row = state.storage.sql.exec(`SELECT * FROM ${TABLE_NAME}`).toArray()[0];
      const used = state.storage.sql.exec(`SELECT * FROM ${USED_REF_TABLE_NAME}`).toArray()[0];
      return { result, columns, row, used };
    });

    expect(created.result).toEqual({
      ok: true,
      created: true,
      reference: {
        savedPlaceRef: 'saved-eviction',
        ownerScopeRef: OWNER_A,
        provider: 'google_places',
        recordRef: input.recordRef,
      },
    });
    expect(created.columns).toEqual([
      'saved_place_ref',
      'owner_scope_ref',
      'provider',
      'record_ref',
    ]);
    expect(created.row).toEqual({
      saved_place_ref: 'saved-eviction',
      owner_scope_ref: OWNER_A,
      provider: 'google_places',
      record_ref: input.recordRef,
    });
    expect(created.used).toEqual({ saved_place_ref: 'saved-eviction' });
    expect(Object.keys(created.row ?? {})).not.toEqual(
      expect.arrayContaining(['payload', 'name', 'location', 'observations']),
    );

    await evictDurableObject(stub);
    const restored = await withStore(
      testEnv(env).THREADS.getByName(threadId),
      idsFor('unused'),
      (store) => store.read(OWNER_A, 'saved-eviction'),
    );
    if (!created.result.ok) throw new Error('M16_REFERENCE_CREATE_FAILED');
    expect(restored).toEqual({ ok: true, reference: created.result.reference });
  });

  it('deduplicates one identity while isolating owners', async () => {
    const { stub } = newThread('owners');
    const result = await withStore(stub, idsFor('saved-a', 'saved-b'), (store) => {
      const a = store.register(registration(OWNER_A, 'ChIJowner-a'));
      const duplicate = store.register(registration(OWNER_A, 'ChIJowner-a'));
      const b = store.register(registration(OWNER_B, 'ChIJowner-b'));
      if (!a.ok || !b.ok) throw new Error('M16_REFERENCE_SETUP_FAILED');
      return {
        a,
        duplicate,
        b,
        ownerAReadsB: store.read(OWNER_A, b.reference.savedPlaceRef),
        ownerBReadsB: store.read(OWNER_B, b.reference.savedPlaceRef),
        ownerARemovesB: store.remove(OWNER_A, b.reference.savedPlaceRef),
      };
    });

    expect(result.a).toMatchObject({ ok: true, created: true });
    expect(result.duplicate).toEqual({ ...result.a, created: false });
    expect(result.b).toMatchObject({ ok: true, created: true });
    expect(result.ownerAReadsB).toEqual({ ok: true, reference: null });
    if (!result.b.ok) throw new Error('M16_REFERENCE_CREATE_FAILED');
    expect(result.ownerBReadsB).toEqual({ ok: true, reference: result.b.reference });
    expect(result.ownerARemovesB).toEqual({ ok: true, deleted: false });
  });

  it('revokes an old reference and issues a new one for re-registration', async () => {
    const { stub } = newThread('reregister');
    const result = await withStore(stub, idsFor('saved-before', 'saved-after'), (store) => {
      const first = store.register(registration(OWNER_A, 'ChIJreregister'));
      if (!first.ok) throw new Error('M16_REFERENCE_SETUP_FAILED');
      const deleted = store.remove(OWNER_A, first.reference.savedPlaceRef);
      const oldRead = store.read(OWNER_A, first.reference.savedPlaceRef);
      const oldDelete = store.remove(OWNER_A, first.reference.savedPlaceRef);
      const second = store.register(registration(OWNER_A, 'ChIJreregister'));
      return { first, deleted, oldRead, oldDelete, second };
    });

    expect(result.deleted).toEqual({ ok: true, deleted: true });
    expect(result.oldRead).toEqual({ ok: true, reference: null });
    expect(result.oldDelete).toEqual({ ok: true, deleted: false });
    expect(result.second).toMatchObject({ ok: true, created: true });
    if (!result.first.ok || !result.second.ok) throw new Error('M16_REREGISTER_FAILED');
    expect(result.second.reference.savedPlaceRef).not.toBe(result.first.reference.savedPlaceRef);
  });

  it('rejects reuse of a revoked opaque reference, even across owners', async () => {
    const { stub } = newThread('tombstone');
    const result = await withStore(stub, idsFor('saved-revoked', 'saved-revoked'), (store) => {
      const first = store.register(registration(OWNER_A, 'ChIJrevoked'));
      if (!first.ok) throw new Error('M16_REFERENCE_SETUP_FAILED');
      const deleted = store.remove(OWNER_A, first.reference.savedPlaceRef);
      const reused = store.register(registration(OWNER_B, 'ChIJnew-owner'));
      return { first, deleted, reused };
    });

    expect(result.deleted).toEqual({ ok: true, deleted: true });
    expect(result.reused).toEqual({ ok: false, code: 'REFERENCE_CONFLICT' });
  });

  it('serializes concurrent registrations without a partial identity', async () => {
    const { stub } = newThread('concurrent');
    await withStore(stub, idsFor('saved-race'), () => undefined);
    const outcomes = await Promise.all([
      withStore(stub, idsFor('saved-race'), (store) =>
        store.register(registration(OWNER_A, 'ChIJrace-a')),
      ),
      withStore(stub, idsFor('saved-race'), (store) =>
        store.register(registration(OWNER_B, 'ChIJrace-b')),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      { ok: false, code: 'REFERENCE_CONFLICT' },
    ]);
    const rows = await withStore(stub, idsFor('unused'), (_store, state) =>
      state.storage.sql.exec(`SELECT * FROM ${TABLE_NAME}`).toArray(),
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects provider payload fields before any durable write', async () => {
    const { stub } = newThread('invalid');
    const observed = await withStore(
      stub,
      {
        nextSavedPlaceRef: () => {
          throw new Error('M16_ID_FACTORY_SHOULD_NOT_RUN');
        },
      },
      (store, state) => {
        const result = store.register({
          ...registration(OWNER_A, 'ChIJinvalid'),
          name: 'provider canary',
          location: { lat: 35.0, lng: 139.0 },
          observations: [{ value: 'secret provider payload' }],
          payload: 'raw provider response',
        });
        const activeCount = state.storage.sql
          .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${TABLE_NAME}`)
          .toArray()[0]?.count;
        const usedCount = state.storage.sql
          .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${USED_REF_TABLE_NAME}`)
          .toArray()[0]?.count;
        return { result, activeCount, usedCount };
      },
    );

    expect(observed.result).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(observed.activeCount).toBe(0);
    expect(observed.usedCount).toBe(0);
  });

  it('returns a typed failure for an invalid generated ref without writing', async () => {
    const { stub } = newThread('invalid-generated');
    const observed = await withStore(stub, idsFor('invalid ref'), (store, state) => {
      const result = store.register(registration(OWNER_A, 'ChIJinvalid-generated'));
      const activeCount = state.storage.sql
        .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${TABLE_NAME}`)
        .toArray()[0]?.count;
      const usedCount = state.storage.sql
        .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM ${USED_REF_TABLE_NAME}`)
        .toArray()[0]?.count;
      return { result, activeCount, usedCount };
    });

    expect(observed.result).toEqual({ ok: false, code: 'INVALID_GENERATED_ID' });
    expect(observed.activeCount).toBe(0);
    expect(observed.usedCount).toBe(0);
  });

  it('reports a corrupt stored identity without exposing it as a valid reference', async () => {
    const { stub } = newThread('corrupt');
    const result = await withStore(stub, idsFor('saved-corrupt'), (store, state) => {
      const created = store.register(registration(OWNER_A, 'ChIJcorrupt'));
      if (!created.ok) throw new Error('M16_REFERENCE_SETUP_FAILED');
      state.storage.sql.exec(
        `UPDATE ${TABLE_NAME} SET provider = '' WHERE saved_place_ref = ?`,
        created.reference.savedPlaceRef,
      );
      return {
        read: store.read(OWNER_A, created.reference.savedPlaceRef),
        remove: store.remove(OWNER_A, created.reference.savedPlaceRef),
      };
    });

    expect(result).toEqual({
      read: { ok: false, code: 'CORRUPT_ROW' },
      remove: { ok: false, code: 'CORRUPT_ROW' },
    });
  });
});
