import type {
  PlacesSearchCursorBinding,
  PlacesSearchCursorResolution,
  PlacesSearchCursorState,
} from '@worker/adapters/out/providers/places-search/types';

export const PLACES_SEARCH_CURSOR_TTL_MS = 5 * 60 * 1_000;
const CURSOR_VERSION = 'v1';
const NONCE_BYTES = 16;
const MAX_CURSOR_LENGTH = 512;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type PlacesSearchCursorStoreOptions = {
  /** A Worker secret; it is used only by Web Crypto and never placed in the cursor. */
  readonly secret: string | Uint8Array;
  readonly now: () => number;
  readonly nonceFactory?: () => Uint8Array;
};

export interface PlacesSearchCursorStore {
  issue(state: PlacesSearchCursorState): Promise<string>;
  resolve(token: string, binding: PlacesSearchCursorBinding): Promise<PlacesSearchCursorResolution>;
  dispose(): void;
}

class PlacesSearchCursorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacesSearchCursorConfigurationError';
  }
}

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
};

const isValidClockValue = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const isValidArea = (area: PlacesSearchCursorBinding['area']): boolean => {
  if (typeof area !== 'object' || area === null) return false;
  if (area.kind === 'named_area') {
    return typeof area.name === 'string' && area.name.length > 0 && area.name.length <= 160;
  }
  return (
    area.kind === 'current_location' &&
    Number.isFinite(area.radiusMeters) &&
    area.radiusMeters >= 100 &&
    area.radiusMeters <= 3_000
  );
};

const isValidBinding = (binding: PlacesSearchCursorBinding): boolean => {
  if (typeof binding !== 'object' || binding === null) return false;
  if (
    typeof binding.ownerScopeRef !== 'string' ||
    typeof binding.threadId !== 'string' ||
    !ID_PATTERN.test(binding.ownerScopeRef) ||
    !ID_PATTERN.test(binding.threadId)
  ) {
    return false;
  }
  if (
    typeof binding.query !== 'string' ||
    binding.query.length === 0 ||
    binding.query.length > 200
  ) {
    return false;
  }
  if (!isValidArea(binding.area)) return false;
  if (!Number.isSafeInteger(binding.limit) || binding.limit < 1 || binding.limit > 10) return false;
  if (!Number.isSafeInteger(binding.locationRevision) || binding.locationRevision < 0) return false;
  if (!Array.isArray(binding.excludeCandidateIds) || binding.excludeCandidateIds.length > 50) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidateId of binding.excludeCandidateIds) {
    if (typeof candidateId !== 'string' || !ID_PATTERN.test(candidateId) || ids.has(candidateId)) {
      return false;
    }
    ids.add(candidateId);
  }
  return typeof binding.openNow === 'boolean';
};

const bindingKey = (binding: PlacesSearchCursorBinding): string | undefined => {
  try {
    if (!isValidBinding(binding)) return undefined;
    const area =
      binding.area.kind === 'named_area'
        ? { kind: 'named_area', name: binding.area.name }
        : { kind: 'current_location', radiusMeters: binding.area.radiusMeters };
    return JSON.stringify({
      ownerScopeRef: binding.ownerScopeRef,
      threadId: binding.threadId,
      query: binding.query,
      area,
      openNow: binding.openNow,
      limit: binding.limit,
      excludeCandidateIds: [...binding.excludeCandidateIds].sort(),
      locationRevision: binding.locationRevision,
    });
  } catch {
    return undefined;
  }
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

const randomNonce = (): Uint8Array => {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
};

export const createPlacesSearchCursorStore = (
  options: PlacesSearchCursorStoreOptions,
): PlacesSearchCursorStore => {
  const secretBytes =
    typeof options.secret === 'string'
      ? new TextEncoder().encode(options.secret)
      : new Uint8Array(options.secret);
  if (secretBytes.byteLength < 16) {
    throw new PlacesSearchCursorConfigurationError('cursor secret is too short');
  }

  const keyPromise = crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const states = new Map<
    string,
    {
      readonly binding: PlacesSearchCursorBinding;
      readonly pageToken: string;
      readonly expiresAtMs: number;
    }
  >();
  const reservedNonces = new Set<string>();
  let generation = 0;
  let disposed = false;
  const nonceFor = options.nonceFactory ?? randomNonce;

  const purge = (now: number): void => {
    for (const [nonce, state] of states) {
      if (state.expiresAtMs <= now) states.delete(nonce);
    }
  };

  const issue = async (state: PlacesSearchCursorState): Promise<string> => {
    if (disposed) throw new PlacesSearchCursorConfigurationError('cursor store is disposed');
    if (
      !isValidBinding(state) ||
      typeof state.providerPageToken !== 'string' ||
      state.providerPageToken.length === 0 ||
      state.providerPageToken.length > 1_024
    ) {
      throw new PlacesSearchCursorConfigurationError('cursor state is invalid');
    }
    const snapshotBinding = copyBinding(state);
    const pageToken = state.providerPageToken;
    const issuedAtMs = options.now();
    if (
      !isValidClockValue(issuedAtMs) ||
      issuedAtMs > Number.MAX_SAFE_INTEGER - PLACES_SEARCH_CURSOR_TTL_MS
    ) {
      throw new PlacesSearchCursorConfigurationError('cursor clock is invalid');
    }
    purge(issuedAtMs);

    const nonce = nonceFor();
    if (!(nonce instanceof Uint8Array) || nonce.byteLength !== NONCE_BYTES) {
      throw new PlacesSearchCursorConfigurationError('cursor nonce is invalid');
    }
    const nonceText = encodeBase64Url(nonce);
    if (states.has(nonceText) || reservedNonces.has(nonceText)) {
      throw new PlacesSearchCursorConfigurationError('cursor nonce collision');
    }
    reservedNonces.add(nonceText);
    const issueGeneration = generation;
    try {
      const unsigned = `${CURSOR_VERSION}.${nonceText}`;
      const key = await keyPromise;
      if (disposed || issueGeneration !== generation) {
        throw new PlacesSearchCursorConfigurationError('cursor store is disposed');
      }
      const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned));
      if (disposed || issueGeneration !== generation) {
        throw new PlacesSearchCursorConfigurationError('cursor store is disposed');
      }
      const signature = new Uint8Array(signed);
      const token = `${unsigned}.${encodeBase64Url(signature)}`;
      if (token.length > MAX_CURSOR_LENGTH) {
        throw new PlacesSearchCursorConfigurationError('cursor is too long');
      }
      states.set(nonceText, {
        binding: snapshotBinding,
        pageToken,
        expiresAtMs: issuedAtMs + PLACES_SEARCH_CURSOR_TTL_MS,
      });
      return token;
    } finally {
      reservedNonces.delete(nonceText);
    }
  };

  const resolve = async (
    token: string,
    binding: PlacesSearchCursorBinding,
  ): Promise<PlacesSearchCursorResolution> => {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH) {
      return { ok: false, code: 'INVALID_CURSOR' };
    }
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) {
      return { ok: false, code: 'INVALID_CURSOR' };
    }
    const nonceText = parts[1];
    const signatureText = parts[2];
    if (nonceText === undefined || signatureText === undefined) {
      return { ok: false, code: 'INVALID_CURSOR' };
    }
    const nonce = decodeBase64Url(nonceText);
    const signature = decodeBase64Url(signatureText);
    if (nonce === undefined || nonce.byteLength !== NONCE_BYTES || signature === undefined) {
      return { ok: false, code: 'INVALID_CURSOR' };
    }

    const key = await keyPromise;
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(`${CURSOR_VERSION}.${nonceText}`),
    );
    if (!valid) return { ok: false, code: 'INVALID_CURSOR' };

    const now = options.now();
    if (!isValidClockValue(now)) return { ok: false, code: 'INVALID_CURSOR' };
    const state = states.get(nonceText);
    if (state === undefined) return { ok: false, code: 'INVALID_CURSOR' };
    if (state.expiresAtMs <= now) {
      states.delete(nonceText);
      return { ok: false, code: 'CURSOR_EXPIRED' };
    }
    purge(now);
    const expectedBinding = bindingKey(binding);
    const actualBinding = bindingKey(state.binding);
    if (
      expectedBinding === undefined ||
      actualBinding === undefined ||
      expectedBinding !== actualBinding
    ) {
      return { ok: false, code: 'INVALID_CURSOR' };
    }
    return { ok: true, providerPageToken: state.pageToken };
  };

  return {
    issue,
    resolve,
    dispose: () => {
      disposed = true;
      generation += 1;
      states.clear();
      reservedNonces.clear();
    },
  };
};
