import { describe, expect, it } from 'vitest';
import type { HttpBoundaryError } from '@worker/infrastructure/adapters/inbound/http/errors';
import type { HandlerContext } from '@worker/infrastructure/adapters/inbound/http/handler';
import { createPhotoBodyHandler } from '@worker/infrastructure/adapters/inbound/http/photo-body-handler';
import { createMemoryPhotoReferenceStore } from '@worker/infrastructure/adapters/outbound/persistence/photo/reference-store';
import { PhotoProviderError } from '@worker/infrastructure/runtime/ports/photo-media';
import { createPhotoTokenCodec } from '@worker/infrastructure/adapters/outbound/security/photo-token-codec';
import type { RuntimeProviderTransportObserver } from '@worker/infrastructure/runtime/tracing/runtime-provider-trace-contract';

const NOW = '2026-09-10T12:00:00.000Z';
const OWNER = 'owner:photo-test';
const DEVICE = 'device:photo-test';
const THREAD = 'thread-photo-test';
const PHOTO_REF = 'places/ChIJfixture/photos/A1B2C3';

const context = (overrides: Partial<HandlerContext> = {}): HandlerContext => ({
  requestId: 'request-photo-test',
  ownerScopeRef: OWNER,
  deviceId: DEVICE,
  appVersion: '1.0.0',
  serverNow: NOW,
  cancellation: { isCancelled: () => false },
  signal: new AbortController().signal,
  ...overrides,
});

const makeHandler = (
  transport: {
    read: (
      photoRef: string,
      signal?: AbortSignal,
      observer?: RuntimeProviderTransportObserver,
    ) =>
      | Promise<never>
      | Promise<{
          body: ReadableStream<Uint8Array>;
          contentType: 'image/jpeg';
          contentLength: number;
        }>;
  },
  providerTraceObserverFor?: Parameters<
    typeof createPhotoBodyHandler
  >[0]['providerTraceObserverFor'],
) => {
  const store = createMemoryPhotoReferenceStore();
  const codec = createPhotoTokenCodec({
    secret: 'photo-http-test-secret',
    referenceResolver: { resolve: () => Promise.resolve(store) },
  });
  return {
    handler: createPhotoBodyHandler({
      tokenCodec: codec,
      transport,
      ...(providerTraceObserverFor === undefined ? {} : { providerTraceObserverFor }),
    }),
    issue: () =>
      codec.issue(
        {
          ownerScopeRef: OWNER,
          threadId: THREAD,
          turnId: 'turn-photo-test',
          revision: 1,
          deviceId: DEVICE,
          photoRef: PHOTO_REF,
        },
        NOW,
      ),
  };
};

describe('photo HTTP adapter', () => {
  it('verifies the authenticated token and preserves the provider stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const transport = {
      read: () =>
        Promise.resolve({ body: stream, contentType: 'image/jpeg' as const, contentLength: 2 }),
    };
    const instance = makeHandler(transport);
    const token = await instance.issue();
    const result = await instance.handler.read({ token }, context());

    expect(result.descriptor).toMatchObject({
      requestId: 'request-photo-test',
      token,
      contentType: 'image/jpeg',
      expiresAt: '2026-09-10T12:30:00.000Z',
    });
    expect(result.body).toBe(stream);
    if (!(result.body instanceof ReadableStream)) throw new Error('expected photo stream');
    const reader = result.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array([1, 2]),
    });
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it('maps a token scope mismatch to a public forbidden boundary', async () => {
    const instance = makeHandler({
      read: () => Promise.reject(new Error('transport must not run')),
    });
    const token = await instance.issue();
    await expect(
      instance.handler.authorize?.({ token }, context({ deviceId: 'device-other' })),
    ).rejects.toMatchObject({
      failure: { status: 403, code: 'FORBIDDEN' },
    } satisfies Partial<HttpBoundaryError>);
  });

  it('maps provider rate limits without exposing upstream details', async () => {
    const instance = makeHandler({
      read: () => Promise.reject(new PhotoProviderError('RATE_LIMITED', 1_250)),
    });
    const token = await instance.issue();
    await expect(instance.handler.read({ token }, context())).rejects.toMatchObject({
      failure: { status: 429, code: 'RATE_LIMITED' },
      retryAfterSeconds: 2,
    });
  });

  it('passes verified source identity to the transport observer without changing the DTO', async () => {
    let receivedObserver: RuntimeProviderTransportObserver | undefined;
    const identity = {
      ownerScopeRef: OWNER,
      threadId: THREAD,
      turnId: 'turn-photo-test',
      revision: 1,
    };
    const observer = { begin: () => ({ complete: () => undefined }) };
    const instance = makeHandler(
      {
        read: (_photoRef, _signal, suppliedObserver) => {
          receivedObserver = suppliedObserver;
          return Promise.resolve({
            body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
            contentType: 'image/jpeg' as const,
            contentLength: 0,
          });
        },
      },
      (received) => {
        expect(received).toEqual(identity);
        return observer;
      },
    );
    const token = await instance.issue();
    const result = await instance.handler.read({ token }, context());

    expect(receivedObserver).toBe(observer);
    expect(result.descriptor).not.toHaveProperty('turnId');
    expect(result.descriptor).not.toHaveProperty('revision');
  });

  it('does not let observer construction failure block a photo response', async () => {
    const instance = makeHandler(
      {
        read: () =>
          Promise.resolve({
            body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
            contentType: 'image/jpeg' as const,
            contentLength: 0,
          }),
      },
      () => {
        throw new Error('diagnostic failure');
      },
    );
    const token = await instance.issue();
    await expect(instance.handler.read({ token }, context())).resolves.toMatchObject({
      descriptor: { requestId: 'request-photo-test' },
    });
  });
});
