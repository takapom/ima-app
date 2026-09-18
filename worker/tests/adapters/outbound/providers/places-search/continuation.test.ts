import { describe, expect, it, vi } from 'vitest';
import { createPlacesSearchContinuation } from '@worker/infrastructure/adapters/outbound/providers/places-search/continuation';
import {
  createPlacesSearchCursorStore,
  PLACES_SEARCH_CURSOR_TTL_MS,
  type PlacesSearchCursorStore,
} from '@worker/infrastructure/adapters/outbound/providers/places-search/cursor';
import type {
  PlacesSearchCursorBinding,
  PlacesSearchCursorState,
} from '@worker/infrastructure/adapters/outbound/providers/places-search/types';

const binding = (): PlacesSearchCursorBinding => ({
  ownerScopeRef: 'owner-continuation',
  threadId: 'thread-continuation',
  query: '静かなカフェ',
  area: { kind: 'named_area', name: '渋谷' },
  openNow: true,
  limit: 2,
  excludeCandidateIds: [],
  locationRevision: 1,
});

const state = (pageToken = 'provider-page-token'): PlacesSearchCursorState => ({
  ...binding(),
  providerPageToken: pageToken,
});

const makeStore = (now: () => number, nonceFactory?: () => Uint8Array): PlacesSearchCursorStore =>
  nonceFactory === undefined
    ? createPlacesSearchCursorStore({ secret: 'continuation-fixture-secret', now })
    : createPlacesSearchCursorStore({ secret: 'continuation-fixture-secret', now, nonceFactory });

const nonceFactory = (): (() => Uint8Array) => {
  let value = 0;
  return () => {
    value += 1;
    const nonce = new Uint8Array(16);
    nonce[0] = Math.floor(value / 256);
    nonce[1] = value % 256;
    return nonce;
  };
};

describe('Places search continuation bridge', () => {
  it('snapshots state before signing so caller mutation cannot change the binding', async () => {
    let releaseSign: (() => void) | undefined;
    let started: (() => void) | undefined;
    const signStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(
      (algorithm, key, data) =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          started?.();
          releaseSign = () => {
            void originalSign(algorithm, key, data).then(resolve, reject);
          };
        }),
    );
    try {
      const store = makeStore(
        () => 100,
        () => new Uint8Array(16).fill(1),
      );
      const continuation = createPlacesSearchContinuation({ store, now: () => 100 });
      const mutable = {
        ...state(),
        area: { kind: 'named_area' as const, name: '渋谷' },
        excludeCandidateIds: [] as string[],
      };
      const issuing = continuation.issue(mutable);
      await signStarted;
      mutable.area = { kind: 'named_area', name: '別の場所' };
      mutable.excludeCandidateIds.push('candidate-mutated');
      releaseSign?.();
      const token = await issuing;
      await expect(continuation.resolve(token)).resolves.toMatchObject({
        ok: true,
        binding: binding(),
        providerPageToken: 'provider-page-token',
      });
    } finally {
      sign.mockRestore();
    }
  });

  it('bounds host-side entries and forgets the oldest token after 512 issues', async () => {
    const now = 100;
    const store = makeStore(() => now, nonceFactory());
    const continuation = createPlacesSearchContinuation({ store, now: () => now });
    const tokens: string[] = [];
    for (let index = 0; index < 513; index += 1) {
      tokens.push(await continuation.issue(state(`provider-${index}`)));
    }
    await expect(continuation.resolve(tokens[0] ?? '')).resolves.toEqual({
      ok: false,
      code: 'INVALID_CURSOR',
    });
    await expect(continuation.resolve(tokens[512] ?? '')).resolves.toMatchObject({ ok: true });
  });

  it('rejects a resolve that crosses the expiry boundary while C1 verification is pending', async () => {
    let now = 100;
    const store = makeStore(
      () => now,
      () => new Uint8Array(16).fill(9),
    );
    const continuation = createPlacesSearchContinuation({ store, now: () => now });
    const token = await continuation.issue(state());
    let release: (() => void) | undefined;
    let underlyingResolved: (() => void) | undefined;
    const underlyingDone = new Promise<void>((resolve) => {
      underlyingResolved = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalResolve = store.resolve.bind(store);
    const resolve = vi.spyOn(store, 'resolve').mockImplementation(async (value, expected) => {
      const result = await originalResolve(value, expected);
      underlyingResolved?.();
      await pending;
      return result;
    });
    try {
      const resolving = continuation.resolve(token);
      await underlyingDone;
      now += PLACES_SEARCH_CURSOR_TTL_MS;
      release?.();
      await expect(resolving).resolves.toEqual({ ok: false, code: 'CURSOR_EXPIRED' });
    } finally {
      resolve.mockRestore();
    }
  });
});
