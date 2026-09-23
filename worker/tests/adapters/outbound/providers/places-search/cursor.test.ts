import { describe, expect, it, vi } from 'vitest';
import {
  createPlacesSearchCursorStore,
  PLACES_SEARCH_CURSOR_TTL_MS,
} from '@worker/adapters/out/providers/places-search/cursor';
import type {
  PlacesSearchCursorBinding,
  PlacesSearchCursorState,
} from '@worker/adapters/out/providers/places-search/types';

const binding = (): PlacesSearchCursorBinding => ({
  ownerScopeRef: 'owner-places',
  threadId: 'thread-places',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  limit: 2,
  excludeCandidateIds: ['candidate-2', 'candidate-1'],
  locationRevision: 4,
});

const state = (): PlacesSearchCursorState => ({
  ...binding(),
  providerPageToken: 'provider-token-must-stay-server-side',
});

const nonce = (value: number): Uint8Array => {
  const bytes = new Uint8Array(16);
  bytes.fill(value);
  return bytes;
};

describe('Places search cursor store', () => {
  it('issues an opaque short token and resolves the server-side provider token', async () => {
    let now = 100;
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => now,
      nonceFactory: () => nonce(1),
    });
    const token = await store.issue(state());

    expect(token.length).toBeLessThanOrEqual(512);
    expect(token).not.toContain('provider-token-must-stay-server-side');
    await expect(store.resolve(token, binding())).resolves.toEqual({
      ok: true,
      providerPageToken: 'provider-token-must-stay-server-side',
    });

    now += 1;
    await expect(
      store.resolve(token, { ...binding(), excludeCandidateIds: ['candidate-1', 'candidate-2'] }),
    ).resolves.toEqual({
      ok: true,
      providerPageToken: 'provider-token-must-stay-server-side',
    });
    const reorderedArea: PlacesSearchCursorBinding = {
      ...binding(),
      area: { name: '渋谷', kind: 'named_area' },
    };
    await expect(store.resolve(token, reorderedArea)).resolves.toMatchObject({ ok: true });
  });

  it('rejects a v1 cursor issued before openNow left the binding', async () => {
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => 100,
      nonceFactory: () => nonce(3),
    });
    const token = await store.issue(state());
    expect(token.startsWith('v2.')).toBe(true);
    await expect(store.resolve(`v1.${token.slice('v2.'.length)}`, binding())).resolves.toEqual({
      ok: false,
      code: 'INVALID_CURSOR',
    });
  });

  it('rejects tampering and every changed cursor binding', async () => {
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => 100,
      nonceFactory: () => nonce(2),
    });
    const token = await store.issue(state());
    const last = token.at(-1);
    if (last === undefined) throw new Error('cursor token is empty');
    const tampered = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    await expect(store.resolve(tampered, binding())).resolves.toEqual({
      ok: false,
      code: 'INVALID_CURSOR',
    });

    const changedBindings: PlacesSearchCursorBinding[] = [
      { ...binding(), ownerScopeRef: 'owner-other' },
      { ...binding(), threadId: 'thread-other' },
      { ...binding(), query: '別の検索' },
      { ...binding(), limit: 3 },
      { ...binding(), locationRevision: 5 },
      { ...binding(), area: { kind: 'named_area', name: '新宿' } },
    ];
    for (const changed of changedBindings) {
      await expect(store.resolve(token, changed)).resolves.toEqual({
        ok: false,
        code: 'INVALID_CURSOR',
      });
    }
  });

  it('expires at the five-minute boundary and forgets the provider token', async () => {
    let now = 1_000;
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => now,
      nonceFactory: () => nonce(3),
    });
    const token = await store.issue(state());
    now += PLACES_SEARCH_CURSOR_TTL_MS - 1;
    await expect(store.resolve(token, binding())).resolves.toMatchObject({ ok: true });
    now += 1;
    await expect(store.resolve(token, binding())).resolves.toEqual({
      ok: false,
      code: 'CURSOR_EXPIRED',
    });
    await expect(store.resolve(token, binding())).resolves.toEqual({
      ok: false,
      code: 'INVALID_CURSOR',
    });
  });

  it('copies binding state and rejects invalid configuration without issuing a token', async () => {
    const exclusions = ['candidate-1'];
    const input: PlacesSearchCursorState = { ...state(), excludeCandidateIds: exclusions };
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => 100,
      nonceFactory: () => nonce(4),
    });
    const token = await store.issue(input);
    exclusions.push('candidate-2');
    await expect(
      store.resolve(token, { ...binding(), excludeCandidateIds: ['candidate-1'] }),
    ).resolves.toMatchObject({
      ok: true,
    });

    await expect(store.issue({ ...state(), ownerScopeRef: 'bad scope' })).rejects.toThrow(
      'cursor state is invalid',
    );
    expect(() => createPlacesSearchCursorStore({ secret: 'short', now: () => 100 })).toThrow(
      'cursor secret is too short',
    );
  });

  it('does not resolve after disposal or for malformed tokens', async () => {
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => 100,
      nonceFactory: () => nonce(5),
    });
    const token = await store.issue(state());
    store.dispose();
    await expect(store.resolve(token, binding())).resolves.toEqual({
      ok: false,
      code: 'INVALID_CURSOR',
    });
    await expect(store.resolve('not-a-cursor', binding())).resolves.toEqual({
      ok: false,
      code: 'INVALID_CURSOR',
    });
  });

  it('reserves a nonce while signing so concurrent issues cannot overwrite state', async () => {
    const store = createPlacesSearchCursorStore({
      secret: 'a sufficiently long cursor secret',
      now: () => 100,
      nonceFactory: () => nonce(6),
    });
    const results = await Promise.allSettled([store.issue(state()), store.issue(state())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('does not restore a cursor when disposal races with signature completion', async () => {
    let releaseSign: ((value: ArrayBuffer) => void) | undefined;
    let started: (() => void) | undefined;
    const signStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          releaseSign = resolve;
          started?.();
        }),
    );
    try {
      const store = createPlacesSearchCursorStore({
        secret: 'a sufficiently long cursor secret',
        now: () => 100,
        nonceFactory: () => nonce(7),
      });
      const issuing = store.issue(state());
      await signStarted;
      store.dispose();
      releaseSign?.(new ArrayBuffer(32));
      await expect(issuing).rejects.toThrow('cursor store is disposed');
      await expect(store.resolve('not-a-cursor', binding())).resolves.toEqual({
        ok: false,
        code: 'INVALID_CURSOR',
      });
    } finally {
      sign.mockRestore();
    }
  });
});
