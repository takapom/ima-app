import { describe, expect, it } from 'vitest';
import { deriveOwnerScopeRef } from '@api/http/auth';
import { routeRequest } from '@api/http/router';
import { createPhotoBodyHandler } from '@api/providers/photo/http';
import { createMemoryPhotoReferenceStore } from '@api/providers/photo/reference-store';
import { createPhotoTokenCodec } from '@api/providers/photo/token';
import { makeHarness, makeRequest, ownerCredential } from '../../http/router-fixtures';

const NOW = '2026-09-10T12:00:00.000Z';
const PHOTO_REF = 'places/ChIJfixture/photos/A1B2C3';

const makePhotoHandler = async (options: {
  readonly body: ReadableStream<Uint8Array>;
  readonly expiresAt?: string;
}) => {
  const ownerScopeRef = await deriveOwnerScopeRef(ownerCredential);
  if (ownerScopeRef === null) throw new Error('fixture owner scope missing');
  const store = createMemoryPhotoReferenceStore();
  const codec = createPhotoTokenCodec({
    secret: 'router-photo-secret',
    referenceResolver: { resolve: () => Promise.resolve(store) },
  });
  const token = await codec.issue(
    {
      ownerScopeRef,
      threadId: 'thread-1',
      turnId: 'turn-1',
      revision: 1,
      deviceId: 'device-1',
      photoRef: PHOTO_REF,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    },
    NOW,
  );
  const handler = createPhotoBodyHandler({
    tokenCodec: codec,
    transport: {
      read: () =>
        Promise.resolve({
          body: options.body,
          contentType: 'image/jpeg' as const,
          contentLength: null,
        }),
    },
  });
  return { handler, token };
};

describe('photo router integration', () => {
  it('authenticates a token-bound stream and sends no-store headers', async () => {
    const instance = await makePhotoHandler({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([7, 8]));
          controller.close();
        },
      }),
    });
    const harness = makeHarness();
    const config = {
      ...harness.config,
      handlers: { ...harness.config.handlers, photo: instance.handler },
    };
    const response = await routeRequest(
      makeRequest(`/v1/photos/${encodeURIComponent(instance.token)}`),
      config,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 8]);
  });

  it('cancels an unconsumed provider stream when expiry is observed at response time', async () => {
    let cancelCount = 0;
    const instance = await makePhotoHandler({
      expiresAt: '2026-09-10T12:00:01.000Z',
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelCount += 1;
        },
      }),
    });
    const harness = makeHarness({ nowValues: [NOW, '2026-09-10T12:00:02.000Z'] });
    const config = {
      ...harness.config,
      handlers: { ...harness.config.handlers, photo: instance.handler },
    };
    const response = await routeRequest(
      makeRequest(`/v1/photos/${encodeURIComponent(instance.token)}`),
      config,
    );

    expect(response.status).toBe(410);
    expect(cancelCount).toBe(1);
  });
});
