import { describe, expect, it } from 'vitest';
import { createMemoryPhotoReferenceStore } from '@worker/adapters/outbound/persistence/photo/reference-store';
import { createPhotoTokenCodec } from '@worker/adapters/outbound/security/photo-token-codec';
import {
  PhotoTokenError,
  type PhotoReferenceStoreWithClear,
  type PhotoTokenInput,
} from '@worker/runtime/ports/photo';

const NOW = '2026-09-10T12:00:00.000Z';
const SECRET = 'photo-token-fixture-secret';
const MAX_THREAD_ID = 't'.repeat(128);
const input: PhotoTokenInput = {
  ownerScopeRef: 'owner:fixture-a',
  threadId: 'thread-fixture-a',
  turnId: 'turn-fixture-a',
  revision: 1,
  deviceId: 'device:fixture-a',
  photoRef: 'places/ChIJfixture/photos/A1B2C3',
};

const makeCodec = (maxEntries?: number) => {
  const store =
    maxEntries === undefined
      ? createMemoryPhotoReferenceStore()
      : createMemoryPhotoReferenceStore({ maxEntries });
  return createPhotoTokenCodec({
    secret: SECRET,
    referenceResolver: {
      resolve: (threadId) =>
        Promise.resolve(
          threadId === input.threadId || threadId === MAX_THREAD_ID ? store : undefined,
        ),
    },
  });
};

const nonCanonicalLastCharacter = (segment: string): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const current = segment[segment.length - 1];
  if (current === undefined) throw new Error('empty base64url segment');
  const currentIndex = alphabet.indexOf(current);
  const highBits = currentIndex & 0b111100;
  const replacement = [...alphabet].find(
    (character, index) => (index & 0b111100) === highBits && (index & 0b11) !== 0,
  );
  if (replacement === undefined) throw new Error('missing non-canonical character');
  return `${segment.slice(0, -1)}${replacement}`;
};

describe('photo token codec', () => {
  it('issues an opaque token bound to owner, thread, device, and source turn', async () => {
    const instance = makeCodec();
    const token = await instance.issue(input, NOW);

    expect(token.length).toBeLessThanOrEqual(512);
    expect(token).toMatch(/^p1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(token).not.toContain(input.ownerScopeRef);
    expect(token).not.toContain(input.threadId);
    expect(token).not.toContain(input.photoRef);
    expect(token).not.toContain(SECRET);
    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: input.ownerScopeRef,
          threadId: input.threadId,
          deviceId: input.deviceId,
        },
        NOW,
      ),
    ).resolves.toMatchObject({
      ownerScopeRef: input.ownerScopeRef,
      threadId: input.threadId,
      photoRef: input.photoRef,
      expiresAt: '2026-09-10T12:30:00.000Z',
      turnId: input.turnId,
      revision: input.revision,
    });
  });

  it('does not expose source turn identity in the public token payload', async () => {
    const instance = makeCodec();
    const token = await instance.issue(input, NOW);
    expect(token).not.toContain(input.turnId);
    const payloadSegment = token.split('.')[1];
    if (payloadSegment === undefined) throw new Error('token payload missing');
    const payload = JSON.parse(
      atob(
        payloadSegment
          .replaceAll('-', '+')
          .replaceAll('_', '/')
          .padEnd(Math.ceil(payloadSegment.length / 4) * 4, '='),
      ),
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('turnId');
    expect(payload).not.toHaveProperty('revision');
  });

  it('keeps legacy references unmeasured and rejects partially migrated identity', async () => {
    const base = createMemoryPhotoReferenceStore();
    const legacyStore: PhotoReferenceStoreWithClear = {
      put(record, requestedNow) {
        return base.put(
          {
            handle: record.handle,
            ownerScopeRef: record.ownerScopeRef,
            threadId: record.threadId,
            deviceIdHash: record.deviceIdHash,
            photoRef: record.photoRef,
            expiresAt: record.expiresAt,
          },
          requestedNow,
        );
      },
      get: (handle, now, scope) => base.get(handle, now, scope),
      clear: () => base.clear(),
    };
    const instance = createPhotoTokenCodec({
      secret: SECRET,
      referenceResolver: { resolve: () => Promise.resolve(legacyStore) },
    });
    const token = await instance.issue(input, NOW);
    await expect(
      instance.verify(token, { ownerScopeRef: input.ownerScopeRef, deviceId: input.deviceId }, NOW),
    ).resolves.not.toHaveProperty('turnId');

    const partialStore: PhotoReferenceStoreWithClear = {
      put(record, requestedNow) {
        return base.put(
          {
            handle: record.handle,
            ownerScopeRef: record.ownerScopeRef,
            threadId: record.threadId,
            turnId: record.turnId,
            deviceIdHash: record.deviceIdHash,
            photoRef: record.photoRef,
            expiresAt: record.expiresAt,
          },
          requestedNow,
        );
      },
      get: (handle, now, scope) => base.get(handle, now, scope),
      clear: () => base.clear(),
    };
    const partial = createPhotoTokenCodec({
      secret: SECRET,
      referenceResolver: { resolve: () => Promise.resolve(partialStore) },
    });
    const partialToken = await partial.issue(input, NOW);
    await expect(
      partial.verify(
        partialToken,
        { ownerScopeRef: input.ownerScopeRef, deviceId: input.deviceId },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
  });

  it('rejects tampering without exposing the provider reference', async () => {
    const instance = makeCodec();
    const token = await instance.issue(input, NOW);
    const last = token.endsWith('A') ? 'B' : 'A';

    await expect(
      instance.verify(
        `${token.slice(0, -1)}${last}`,
        {
          ownerScopeRef: input.ownerScopeRef,
          deviceId: input.deviceId,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a different owner, thread, or device', async () => {
    const instance = makeCodec();
    const token = await instance.issue(input, NOW);

    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: 'owner:other',
          deviceId: input.deviceId,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: input.ownerScopeRef,
          threadId: 'thread:other',
          deviceId: input.deviceId,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: input.ownerScopeRef,
          deviceId: 'device:other',
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });
  });

  it('expires at the configured TTL and rejects a longer requested lifetime', async () => {
    const instance = makeCodec();
    const token = await instance.issue(input, NOW);

    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: input.ownerScopeRef,
          deviceId: input.deviceId,
        },
        '2026-09-10T12:30:00.000Z',
      ),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(
      instance.issue(
        {
          ...input,
          expiresAt: '2026-09-10T12:30:01.000Z',
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails closed for missing secrets, malformed input, and invalid clocks', async () => {
    expect(() => createPhotoTokenCodec({ secret: '' })).toThrowError(
      new PhotoTokenError('MISSING_SECRET'),
    );
    await expect(
      makeCodec().issue(
        {
          ...input,
          photoRef: 'https://example.invalid/photo',
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(makeCodec().issue(input, 'not-a-timestamp')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('keeps a maximum-length provider name outside the public token', async () => {
    const instance = makeCodec();
    const longInput: PhotoTokenInput = {
      ...input,
      ownerScopeRef: 'o'.repeat(160),
      threadId: MAX_THREAD_ID,
      deviceId: 'd'.repeat(160),
      photoRef: `places/${'p'.repeat(248)}/photos/${'r'.repeat(249)}`,
    };
    const token = await instance.issue(longInput, NOW);

    expect(longInput.photoRef).toHaveLength(512);
    expect(token.length).toBeLessThanOrEqual(512);
    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: longInput.ownerScopeRef,
          threadId: longInput.threadId,
          deviceId: longInput.deviceId,
        },
        NOW,
      ),
    ).resolves.toMatchObject({ photoRef: longInput.photoRef });
  });

  it('rejects non-canonical base64url and an evicted reference', async () => {
    const instance = makeCodec(1);
    const token = await instance.issue(input, NOW);
    const segments = token.split('.');
    const mac = segments[2];
    if (mac === undefined) throw new Error('missing token MAC');
    segments[2] = nonCanonicalLastCharacter(mac);
    await expect(
      instance.verify(
        segments.join('.'),
        {
          ownerScopeRef: input.ownerScopeRef,
          deviceId: input.deviceId,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });

    const second = { ...input, photoRef: 'places/ChIJfixture/photos/SECOND' };
    await instance.issue(second, NOW);
    await expect(
      instance.verify(
        token,
        {
          ownerScopeRef: input.ownerScopeRef,
          deviceId: input.deviceId,
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'REFERENCE_UNAVAILABLE' });
  });

  it('requires a scoped reference store before issuing tokens', () => {
    expect(() => createPhotoTokenCodec({ secret: SECRET })).toThrowError(
      new PhotoTokenError('REFERENCE_RESOLVER_REQUIRED'),
    );
  });
});
