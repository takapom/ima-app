import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Preferences } from '@ima/contracts';
import { createDurableOwnerStore } from '@worker/adapters/out/persistence/saved-references/durable-owner-store';
import { createOwnerPrefsStore } from '@worker/adapters/out/persistence/saved-references/prefs-store';
import {
  savedReferenceOwnerName,
  type SavedReferenceNamespace,
} from '@worker/adapters/out/persistence/saved-references/saved-reference-do';

type TestEnv = Cloudflare.Env & {
  readonly SAVED_REFERENCES: SavedReferenceNamespace;
};

const hasSavedBinding = (value: typeof env): value is TestEnv =>
  typeof value === 'object' && value !== null && 'SAVED_REFERENCES' in value;

const savedEnv = (value: typeof env): TestEnv => {
  if (!hasSavedBinding(value)) throw new Error('M37_SAVED_REFERENCE_BINDING_MISSING');
  return value;
};

const savedNamespace = (): SavedReferenceNamespace => savedEnv(env).SAVED_REFERENCES;

const ownerFor = (label: string): string => `m37-owner-${label}-${crypto.randomUUID()}`;

const PREFS: Preferences = {
  areaText: 'Shibuya',
  budget: 'normal',
};

const OTHER_PREFS: Preferences = {
  ...PREFS,
  budget: 'cheap',
};

const identity = (recordRef: string) => ({
  provider: 'google_places',
  recordRef,
});

describe('durable OwnerStore adapter', () => {
  it('drops the pre-#55 travel columns and keeps the revision and remaining prefs', async () => {
    const owner = ownerFor('prefs-legacy');
    const stub = savedNamespace().getByName(savedReferenceOwnerName(owner));
    const result = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE owner_prefs');
      state.storage.sql.exec(`
        CREATE TABLE owner_prefs (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL,
          home_station_ref TEXT,
          max_walk_minutes INTEGER,
          minimum_stay_minutes INTEGER,
          area_text TEXT,
          budget TEXT
        )
      `);
      state.storage.sql.exec(
        'INSERT INTO owner_prefs VALUES (1, 3, ?, 12, 45, ?, ?)',
        'station-home',
        'Shibuya',
        'normal',
      );
      const read = createOwnerPrefsStore(state.storage).read();
      const columns = state.storage.sql
        .exec<{ readonly name: string }>("SELECT name FROM pragma_table_info('owner_prefs')")
        .toArray()
        .map((column) => column.name);
      return { read, columns };
    });

    expect(result.read).toEqual({
      ok: true,
      revision: 3,
      prefs: { areaText: 'Shibuya', budget: 'normal' },
    });
    expect(result.columns).toEqual(['singleton', 'revision', 'area_text', 'budget']);
  });

  it('restores prefs after Durable Object eviction', async () => {
    const owner = ownerFor('prefs-evict');
    const namespace = savedNamespace();
    const store = createDurableOwnerStore(namespace);
    const unread = await store.readPrefs(owner);
    const written = await store.putPrefs(owner, { prefs: PREFS, expectedRevision: 0 });

    expect(unread).toEqual({ ok: true, revision: 0, prefs: null });
    expect(written).toEqual({ ok: true, revision: 1, replayed: false });

    await evictDurableObject(namespace.getByName(savedReferenceOwnerName(owner)));
    const restored = await createDurableOwnerStore(namespace).readPrefs(owner);
    expect(restored).toEqual({ ok: true, revision: 1, prefs: PREFS });
  });

  it('rejects a stale expectedRevision without changing the row', async () => {
    const owner = ownerFor('prefs-cas');
    const store = createDurableOwnerStore(savedNamespace());
    const first = await store.putPrefs(owner, { prefs: PREFS, expectedRevision: 0 });
    const conflict = await store.putPrefs(owner, {
      prefs: OTHER_PREFS,
      expectedRevision: 0,
    });
    const read = await store.readPrefs(owner);

    expect(first).toEqual({ ok: true, revision: 1, replayed: false });
    expect(conflict).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(read).toEqual({ ok: true, revision: 1, prefs: PREFS });
  });

  it('replays an identical prefs put without advancing revision', async () => {
    const owner = ownerFor('prefs-replay');
    const store = createDurableOwnerStore(savedNamespace());
    const first = await store.putPrefs(owner, { prefs: PREFS, expectedRevision: 0 });
    const replayed = await store.putPrefs(owner, { prefs: PREFS, expectedRevision: 0 });
    const sameCurrent = await store.putPrefs(owner, { prefs: PREFS, expectedRevision: 1 });
    const read = await store.readPrefs(owner);

    expect(first).toEqual({ ok: true, revision: 1, replayed: false });
    expect(replayed).toEqual({ ok: true, revision: 1, replayed: true });
    expect(sameCurrent).toEqual({ ok: true, revision: 1, replayed: true });
    expect(read).toEqual({ ok: true, revision: 1, prefs: PREFS });
  });

  it('lists an opaque identity, hides other owners, and drops the row after remove', async () => {
    const ownerA = ownerFor('list-a');
    const ownerB = ownerFor('list-b');
    const namespace = savedNamespace();
    const store = createDurableOwnerStore(namespace);
    const created = await store.register(ownerA, identity('ChIJm37-list-a'));
    const other = await store.register(ownerB, identity('ChIJm37-list-b'));
    if (!created.ok) throw new Error('expected owner A registration to succeed');
    if (!other.ok) throw new Error('expected owner B registration to succeed');

    await evictDurableObject(namespace.getByName(savedReferenceOwnerName(ownerA)));
    const cold = createDurableOwnerStore(namespace);
    const listedA = await cold.listSaved(ownerA);
    const listedB = await cold.listSaved(ownerB);
    const removed = await cold.remove(ownerA, created.reference.savedPlaceRef);
    const afterRemove = await cold.listSaved(ownerA);

    expect(created).toMatchObject({ ok: true, created: true });
    expect(listedA).toEqual({ ok: true, references: [created.reference], decided: [] });
    expect(listedB).toEqual({ ok: true, references: [other.reference], decided: [] });
    expect(created.reference).toEqual({
      savedPlaceRef: created.reference.savedPlaceRef,
      ownerScopeRef: ownerA,
      provider: 'google_places',
      recordRef: 'ChIJm37-list-a',
    });
    expect(removed).toEqual({ ok: true, deleted: true });
    expect(afterRemove).toEqual({ ok: true, references: [], decided: [] });
    expect(await cold.listSaved(ownerB)).toEqual({
      ok: true,
      references: [other.reference],
      decided: [],
    });
  });

  it('returns an empty list for an uninitialized owner', async () => {
    const store = createDurableOwnerStore(savedNamespace());
    expect(await store.listSaved(ownerFor('list-empty'))).toEqual({
      ok: true,
      references: [],
      decided: [],
    });
  });

  it('rejects an invalid owner as INVALID_INPUT', async () => {
    const store = createDurableOwnerStore(savedNamespace());
    const invalidOwner = 'owner space';
    expect(await store.readPrefs(invalidOwner)).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(await store.putPrefs(invalidOwner, { prefs: PREFS, expectedRevision: 0 })).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await store.listSaved(invalidOwner)).toEqual({ ok: false, code: 'INVALID_INPUT' });
  });

  it('restores a decision after Durable Object eviction', async () => {
    const owner = ownerFor('decide-evict');
    const namespace = savedNamespace();
    const store = createDurableOwnerStore(namespace);
    const decidedAt = '2026-09-12T12:00:00.000Z';
    const decided = await store.decide(owner, {
      ...identity('ChIJm39-decide'),
      decidedAt,
    });
    if (!decided.ok) throw new Error('expected decide to succeed');

    await evictDurableObject(namespace.getByName(savedReferenceOwnerName(owner)));
    const restored = await createDurableOwnerStore(namespace).listSaved(owner);
    expect(restored).toEqual({
      ok: true,
      references: [decided.reference],
      decided: [{ savedPlaceRef: decided.reference.savedPlaceRef, decidedAt }],
    });
  });
});
