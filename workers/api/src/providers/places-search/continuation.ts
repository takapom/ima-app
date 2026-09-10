import { PLACES_SEARCH_CURSOR_TTL_MS, type PlacesSearchCursorStore } from './cursor';
import type { PlacesSearchCursorBinding, PlacesSearchCursorState } from './types';

export type PlacesSearchContinuationResolution =
  | {
      readonly ok: true;
      readonly binding: PlacesSearchCursorBinding;
      readonly providerPageToken: string;
    }
  | {
      readonly ok: false;
      readonly code: 'INVALID_CURSOR' | 'CURSOR_EXPIRED';
    };

export type PlacesSearchContinuation = {
  readonly issue: (state: PlacesSearchCursorState) => Promise<string>;
  readonly resolve: (cursor: string) => Promise<PlacesSearchContinuationResolution>;
  readonly dispose?: () => void;
};

type ContinuationEntry = {
  readonly binding: PlacesSearchCursorBinding;
  readonly expiresAtMs: number;
};

const MAX_CONTINUATION_ENTRIES = 512;

export type PlacesSearchContinuationOptions = {
  readonly store: PlacesSearchCursorStore;
  readonly now: () => number;
};

const copyBinding = (binding: PlacesSearchCursorBinding): PlacesSearchCursorBinding => ({
  ownerScopeRef: binding.ownerScopeRef,
  threadId: binding.threadId,
  query: binding.query,
  area:
    binding.area.kind === 'named_area'
      ? { kind: 'named_area', name: binding.area.name }
      : { kind: 'current_location', radiusMeters: binding.area.radiusMeters },
  openNow: binding.openNow,
  limit: binding.limit,
  excludeCandidateIds: [...binding.excludeCandidateIds],
  locationRevision: binding.locationRevision,
});

const copyState = (state: PlacesSearchCursorState): PlacesSearchCursorState => ({
  ...copyBinding(state),
  providerPageToken: state.providerPageToken,
});

const isValidNow = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * Bridges the model-facing opaque cursor to the C1 store's binding-aware API.
 * Provider page tokens stay in the C1 store and are never returned to Core.
 */
export const createPlacesSearchContinuation = (
  options: PlacesSearchContinuationOptions,
): PlacesSearchContinuation => {
  const entries = new Map<string, ContinuationEntry>();
  let disposed = false;

  const purge = (now: number): void => {
    for (const [token, entry] of entries) {
      if (entry.expiresAtMs <= now) entries.delete(token);
    }
  };

  const issue = async (state: PlacesSearchCursorState): Promise<string> => {
    if (disposed) throw new Error('places search continuation is disposed');
    const issuedAtMs = options.now();
    if (!isValidNow(issuedAtMs)) throw new Error('places search continuation clock is invalid');
    purge(issuedAtMs);
    const snapshot = copyState(state);
    const token = await options.store.issue(snapshot);
    if (disposed) throw new Error('places search continuation is disposed');
    entries.set(token, {
      binding: copyBinding(snapshot),
      expiresAtMs: issuedAtMs + PLACES_SEARCH_CURSOR_TTL_MS,
    });
    while (entries.size > MAX_CONTINUATION_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return token;
  };

  const resolve = async (token: string): Promise<PlacesSearchContinuationResolution> => {
    if (disposed) return { ok: false, code: 'INVALID_CURSOR' };
    const now = options.now();
    if (!isValidNow(now)) return { ok: false, code: 'INVALID_CURSOR' };
    const entry = entries.get(token);
    if (entry === undefined) return { ok: false, code: 'INVALID_CURSOR' };
    if (entry.expiresAtMs <= now) {
      entries.delete(token);
      return { ok: false, code: 'CURSOR_EXPIRED' };
    }
    const resolved = await options.store.resolve(token, entry.binding);
    if (!resolved.ok) {
      if (resolved.code === 'CURSOR_EXPIRED') entries.delete(token);
      return resolved;
    }
    if (disposed) return { ok: false, code: 'INVALID_CURSOR' };
    const completedAtMs = options.now();
    if (!isValidNow(completedAtMs) || entry.expiresAtMs <= completedAtMs) {
      entries.delete(token);
      return { ok: false, code: 'CURSOR_EXPIRED' };
    }
    return {
      ok: true,
      binding: copyBinding(entry.binding),
      providerPageToken: resolved.providerPageToken,
    };
  };

  return {
    issue,
    resolve,
    dispose: () => {
      disposed = true;
      entries.clear();
      options.store.dispose();
    },
  };
};
