import { describe, expect, it } from 'vitest';
import type { Preferences } from '@ima/contracts';
import { createMemoryOwnerStore } from '@worker/adapters/out/persistence/saved-references/memory-owner-store';
import type { OwnerStore } from '@worker/application/ports/owner-store';

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const INVALID_OWNER = 'owner space';

const PREFS: Preferences = {
  areaText: 'Shibuya',
  budget: 'normal',
};

const OTHER_PREFS: Preferences = {
  ...PREFS,
  budget: 'cheap',
};

const EXTRA_PREFS = {
  ...PREFS,
  extra: 'not-allowed',
};

const identity = (recordRef: string) => ({
  provider: 'google_places',
  recordRef,
});

const storeWithIds = (...refs: readonly string[]): OwnerStore => {
  let index = 0;
  return createMemoryOwnerStore({
    nextSavedPlaceRef: () => {
      const ref = refs[index];
      index += 1;
      return ref ?? `saved-overflow-${index}`;
    },
  });
};

describe('memory owner store prefs', () => {
  it('writes the first prefs at revision 1 and reads them back', async () => {
    const store = createMemoryOwnerStore();
    const unread = await store.readPrefs(OWNER_A);
    const written = await store.putPrefs(OWNER_A, { prefs: PREFS, expectedRevision: 0 });
    const read = await store.readPrefs(OWNER_A);

    expect(unread).toEqual({ ok: true, revision: 0, prefs: null });
    expect(written).toEqual({ ok: true, revision: 1, replayed: false });
    expect(read).toEqual({ ok: true, revision: 1, prefs: PREFS });
  });

  it('rejects a stale expectedRevision without changing the row', async () => {
    const store = createMemoryOwnerStore();
    const first = await store.putPrefs(OWNER_A, { prefs: PREFS, expectedRevision: 0 });
    const conflict = await store.putPrefs(OWNER_A, {
      prefs: OTHER_PREFS,
      expectedRevision: 0,
    });
    const read = await store.readPrefs(OWNER_A);

    expect(first).toEqual({ ok: true, revision: 1, replayed: false });
    expect(conflict).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(read).toEqual({ ok: true, revision: 1, prefs: PREFS });
  });

  it('replays an identical prefs put without advancing revision', async () => {
    const store = createMemoryOwnerStore();
    const first = await store.putPrefs(OWNER_A, { prefs: PREFS, expectedRevision: 0 });
    const replayed = await store.putPrefs(OWNER_A, { prefs: PREFS, expectedRevision: 0 });
    const sameCurrent = await store.putPrefs(OWNER_A, { prefs: PREFS, expectedRevision: 1 });
    const read = await store.readPrefs(OWNER_A);

    expect(first).toEqual({ ok: true, revision: 1, replayed: false });
    expect(replayed).toEqual({ ok: true, revision: 1, replayed: true });
    expect(sameCurrent).toEqual({ ok: true, revision: 1, replayed: true });
    expect(read).toEqual({ ok: true, revision: 1, prefs: PREFS });
  });

  it('keeps prefs isolated across owners', async () => {
    const store = createMemoryOwnerStore();
    await store.putPrefs(OWNER_A, { prefs: PREFS, expectedRevision: 0 });
    await store.putPrefs(OWNER_B, { prefs: OTHER_PREFS, expectedRevision: 0 });

    expect(await store.readPrefs(OWNER_A)).toEqual({
      ok: true,
      revision: 1,
      prefs: PREFS,
    });
    expect(await store.readPrefs(OWNER_B)).toEqual({
      ok: true,
      revision: 1,
      prefs: OTHER_PREFS,
    });
  });

  it('rejects an invalid owner and extra prefs fields as INVALID_INPUT', async () => {
    const store = createMemoryOwnerStore();
    const invalidOwner = await store.putPrefs(INVALID_OWNER, {
      prefs: PREFS,
      expectedRevision: 0,
    });
    const extraField = await store.putPrefs(OWNER_A, {
      prefs: EXTRA_PREFS,
      expectedRevision: 0,
    });
    const unreadInvalid = await store.readPrefs(INVALID_OWNER);
    const unreadValid = await store.readPrefs(OWNER_A);

    expect(invalidOwner).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(extraField).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(unreadInvalid).toEqual({ ok: false, code: 'INVALID_INPUT' });
    expect(unreadValid).toEqual({ ok: true, revision: 0, prefs: null });
  });
});

describe('memory owner store saved references', () => {
  it('lists a registered reference and drops it after remove', async () => {
    const store = storeWithIds('saved-keep');
    const created = await store.register(OWNER_A, identity('ChIJkeep'));
    const listed = await store.listSaved(OWNER_A);
    if (!created.ok) throw new Error('expected registration to succeed');
    const removed = await store.remove(OWNER_A, created.reference.savedPlaceRef);
    const afterRemove = await store.listSaved(OWNER_A);
    const read = await store.read(OWNER_A, created.reference.savedPlaceRef);

    expect(created).toMatchObject({ ok: true, created: true });
    expect(listed).toEqual({ ok: true, references: [created.reference], decided: [] });
    expect(removed).toEqual({ ok: true, deleted: true });
    expect(afterRemove).toEqual({ ok: true, references: [], decided: [] });
    expect(read).toEqual({ ok: true, reference: null });
  });

  it('does not leak saved references across owners', async () => {
    const store = storeWithIds('saved-a', 'saved-b');
    const a = await store.register(OWNER_A, identity('ChIJowner-a'));
    const b = await store.register(OWNER_B, identity('ChIJowner-b'));
    if (!a.ok || !b.ok) throw new Error('expected both owners to register');
    const listA = await store.listSaved(OWNER_A);
    const listB = await store.listSaved(OWNER_B);
    const crossRead = await store.read(OWNER_A, b.reference.savedPlaceRef);

    expect(listA).toEqual({ ok: true, references: [a.reference], decided: [] });
    expect(listB).toEqual({ ok: true, references: [b.reference], decided: [] });
    expect(crossRead).toEqual({ ok: true, reference: null });
  });

  it('returns the existing ref for the same provider and recordRef', async () => {
    const store = storeWithIds('saved-first', 'saved-second');
    const first = await store.register(OWNER_A, identity('ChIJsame'));
    const duplicate = await store.register(OWNER_A, identity('ChIJsame'));
    if (!first.ok) throw new Error('expected first registration to succeed');

    expect(duplicate).toEqual({ ok: true, created: false, reference: first.reference });
    expect(await store.listSaved(OWNER_A)).toEqual({
      ok: true,
      references: [first.reference],
      decided: [],
    });
  });

  it('rejects an invalid owner on list and register', async () => {
    const store = createMemoryOwnerStore();
    expect(await store.listSaved(INVALID_OWNER)).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
    expect(await store.register(INVALID_OWNER, identity('ChIJinvalid'))).toEqual({
      ok: false,
      code: 'INVALID_INPUT',
    });
  });

  it('caps listSaved at 50 active rows without deleting the rest', async () => {
    let index = 0;
    const store = createMemoryOwnerStore({
      nextSavedPlaceRef: () => {
        index += 1;
        return `saved-${index}`;
      },
    });
    for (let n = 1; n <= 51; n += 1) {
      const result = await store.register(OWNER_A, identity(`ChIJcap-${n}`));
      if (!result.ok) throw new Error('expected registration to succeed');
    }
    const listed = await store.listSaved(OWNER_A);
    const overflow = await store.read(OWNER_A, 'saved-51');
    if (!listed.ok) throw new Error('expected listSaved to succeed');
    if (!overflow.ok) throw new Error('expected overflow read to succeed');

    expect(listed.references).toHaveLength(50);
    expect(listed.references[0]?.savedPlaceRef).toBe('saved-1');
    expect(listed.references[49]?.savedPlaceRef).toBe('saved-50');
    expect(overflow.reference?.savedPlaceRef).toBe('saved-51');
  });

  it('records a decision on identity and restores it on list', async () => {
    const store = storeWithIds('saved-decided');
    const decidedAt = '2026-09-12T12:00:00.000Z';
    const decided = await store.decide(OWNER_A, {
      ...identity('ChIJdecided'),
      decidedAt,
    });
    const listed = await store.listSaved(OWNER_A);
    const replayed = await store.decide(
      OWNER_A,
      { ...identity('ChIJdecided'), decidedAt: '2026-09-12T13:00:00.000Z' },
      { idempotencyKey: 'decide-1', idempotencyFingerprint: 'fp-1' },
    );
    const sameKey = await store.decide(
      OWNER_A,
      { ...identity('ChIJdecided'), decidedAt: '2026-09-12T13:00:00.000Z' },
      { idempotencyKey: 'decide-1', idempotencyFingerprint: 'fp-1' },
    );
    const conflict = await store.decide(
      OWNER_A,
      { ...identity('ChIJother'), decidedAt },
      { idempotencyKey: 'decide-1', idempotencyFingerprint: 'fp-other' },
    );

    expect(decided).toMatchObject({
      ok: true,
      created: true,
      replayed: false,
      decidedAt,
    });
    expect(listed).toEqual({
      ok: true,
      references: decided.ok ? [decided.reference] : [],
      decided: decided.ok ? [{ savedPlaceRef: decided.reference.savedPlaceRef, decidedAt }] : [],
    });
    expect(replayed).toMatchObject({ ok: true, created: false, replayed: false });
    expect(sameKey).toMatchObject({
      ok: true,
      replayed: true,
      decidedAt: '2026-09-12T13:00:00.000Z',
    });
    expect(conflict).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT' });
  });
});
