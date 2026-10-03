import { describe, expect, it, vi } from 'vitest';
import {
  APP_TOKEN_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  REQUEST_ID_HEADER,
} from '@ima/contracts';
import { createJourneyPhotoClient } from '@mobile/platform/http/photo-client';
import type { ApiClientOptions, ApiFetch } from '@mobile/platform/http/api';

const now = '2026-09-10T12:00:00.000Z';
const ownerCredential = `${'A'.repeat(42)}A`;

const optionsFor = (
  fetchImpl: ApiFetch,
  overrides: Partial<ApiClientOptions> & { readonly now?: () => string } = {},
): ApiClientOptions & { readonly now: () => string } => ({
  baseUrl: 'http://localhost:8787',
  mode: 'fixture',
  appVersion: 'test',
  credentials: { appToken: 'app-token', deviceId: 'device-1', ownerCredential },
  requestIdFactory: () => 'photo-request-1',
  fetchImpl,
  now: () => now,
  ...overrides,
});

const responseFor = (requestId = 'photo-request-1'): Response =>
  new Response(new Uint8Array([0, 1, 2]), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      expires: 'Thu, 10 Sep 2026 12:05:00 GMT',
      [REQUEST_ID_HEADER]: requestId,
    },
  });

describe('authenticated photo client', () => {
  it('does not start a history request if deletion occurs while credentials are pending', async () => {
    let completeCredentials: (() => void) | undefined;
    const fetchImpl = vi.fn<ApiFetch>(() => Promise.resolve(responseFor()));
    const client = createJourneyPhotoClient(
      optionsFor(fetchImpl, {
        credentials: () =>
          new Promise((resolve) => {
            completeCredentials = () =>
              resolve({ appToken: 'app-token', deviceId: 'device', ownerCredential });
          }),
      }),
    );
    const pending = client.fetchConversationPhoto?.({
      conversationId: 'conversation',
      sequence: 2,
      candidateId: 'shop',
    });
    client.clearConversationPhotos?.();
    completeCredentials?.();
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('shares an in-flight history photo without cancelling the remaining viewer', async () => {
    let complete: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<ApiFetch>(() => new Promise((resolve) => (complete = resolve)));
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));
    const path = { conversationId: 'conversation', sequence: 2, candidateId: 'shop' };
    const thumbnail = new AbortController();
    const first = client.fetchConversationPhoto?.(path, { signal: thumbnail.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const second = client.fetchConversationPhoto?.(path);
    // Let the second consumer finish credentials and join the existing network read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    thumbnail.abort();
    expect(await first).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    complete?.(responseFor());
    expect(await second).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    client.clearConversationPhotos?.();
  });
  it('cancels when every history photo consumer leaves and allows a fresh request', async () => {
    const fetchImpl = vi.fn<ApiFetch>(() => new Promise(() => {}));
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));
    const path = { conversationId: 'conversation', sequence: 2, candidateId: 'shop' };
    const abort = new AbortController();
    const first = client.fetchConversationPhoto?.(path, { signal: abort.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    abort.abort();
    expect(await first).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    fetchImpl.mockResolvedValueOnce(responseFor());
    expect(await client.fetchConversationPhoto?.(path)).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    client.clearConversationPhotos?.();
  });
  it('does not share a pending photo across credentials or restore it after deletion', async () => {
    let deviceId = 'device-1';
    let complete: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<ApiFetch>(() => new Promise((resolve) => (complete = resolve)));
    const client = createJourneyPhotoClient(
      optionsFor(fetchImpl, {
        credentials: () => ({ appToken: 'app-token', deviceId, ownerCredential }),
      }),
    );
    const path = { conversationId: 'conversation', sequence: 2, candidateId: 'shop' };
    const first = client.fetchConversationPhoto?.(path);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const completeFirst = complete;
    deviceId = 'device-2';
    const second = client.fetchConversationPhoto?.(path);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    client.clearConversationPhotos?.();
    completeFirst?.(responseFor());
    complete?.(responseFor());
    expect(await first).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    expect(await second).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    fetchImpl.mockResolvedValueOnce(responseFor());
    expect(await client.fetchConversationPhoto?.(path)).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    client.clearConversationPhotos?.();
  });
  it('also cancels an explicit refresh when the conversation is deleted', async () => {
    const fetchImpl = vi.fn<ApiFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));
    const pending = client.fetchConversationPhoto?.(
      { conversationId: 'conversation', sequence: 2, candidateId: 'shop' },
      { refresh: true },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    client.clearConversationPhotos?.();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
  });
  it('loads history photos independently from expired tokens and reuses only current credential-scoped memory', async () => {
    vi.useFakeTimers();
    try {
      let deviceId = 'device-1';
      let clock = now;
      const fetchImpl = vi.fn<ApiFetch>(() => Promise.resolve(responseFor()));
      const client = createJourneyPhotoClient(
        optionsFor(fetchImpl, {
          credentials: () => ({ appToken: 'app-token', deviceId, ownerCredential }),
          now: () => clock,
        }),
      );
      const path = { conversationId: 'conversation', sequence: 2, candidateId: 'shop' };
      expect(await client.fetchConversationPhoto?.(path)).toMatchObject({ ok: true });
      const request = fetchImpl.mock.calls[0]?.[0];
      expect(request instanceof Request ? request.url : request?.toString()).toContain(
        '/v1/conversations/conversation/messages/2/photos/shop',
      );
      expect(await client.fetchConversationPhoto?.(path)).toMatchObject({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await client.fetchConversationPhoto?.(path, { refresh: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      deviceId = 'device-2';
      await client.fetchConversationPhoto?.(path);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      clock = '2026-09-10T12:06:00Z';
      expect(await client.fetchConversationPhoto?.(path)).toMatchObject({
        ok: false,
        error: { kind: 'expired' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(await client.fetchConversationPhoto?.({ ...path, sequence: 0 })).toMatchObject({
        ok: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('sends the opaque token with the owner-scoped headers and returns an ephemeral image URI', async () => {
    const fetchImpl = vi.fn<ApiFetch>(() => Promise.resolve(responseFor()));
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));

    const result = await client.fetchPhoto('token/opaque');

    expect(result).toMatchObject({
      ok: true,
      requestId: 'photo-request-1',
      data: {
        uri: 'data:image/png;base64,AAEC',
        contentType: 'image/png',
        expiresAt: '2026-09-10T12:05:00.000Z',
      },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const requestUrl =
      url instanceof Request ? url.url : url instanceof URL ? url.toString() : (url ?? '');
    expect(requestUrl).toBe('http://localhost:8787/v1/photos/token%2Fopaque');
    const headers = new Headers(init?.headers);
    expect(headers.get(APP_TOKEN_HEADER)).toBe('app-token');
    expect(headers.get(DEVICE_ID_HEADER)).toBe('device-1');
    expect(headers.get(OWNER_CREDENTIAL_HEADER)).toBe(ownerCredential);
    expect(headers.get(REQUEST_ID_HEADER)).toBe('photo-request-1');
    expect(init?.redirect).toBe('error');
  });

  it('rejects a response from another request before exposing its bytes', async () => {
    const client = createJourneyPhotoClient(
      optionsFor(() => Promise.resolve(responseFor('other'))),
    );

    const result = await client.fetchPhoto('token-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.kind !== 'contract') throw new Error('expected contract failure');
    expect(result.error.issues).toContain('photo response requestId does not match the request');
  });

  it('does not request a photo after its public display deadline', async () => {
    const fetchImpl = vi.fn<ApiFetch>(() => Promise.resolve(responseFor()));
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));

    const result = await client.fetchPhoto('token-1', { displayUntil: now });

    expect(result).toEqual({ ok: false, error: { kind: 'expired' }, requestId: 'photo-request-1' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed public deadlines before authentication or network work', async () => {
    const fetchImpl = vi.fn<ApiFetch>(() => Promise.resolve(responseFor()));
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));

    const result = await client.fetchPhoto('token-1', { displayUntil: 'not-a-timestamp' });

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'contract') throw new Error('expected contract failure');
    expect(result.error.issues).toContain('photo display deadline is invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not expose a body that crossed the effective server or public expiry', async () => {
    let clock = now;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        clock = '2026-09-10T12:05:00.000Z';
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        expires: 'Thu, 10 Sep 2026 12:05:00 GMT',
        [REQUEST_ID_HEADER]: 'photo-request-1',
      },
    });
    const client = createJourneyPhotoClient(
      optionsFor(() => Promise.resolve(response), { now: () => clock }),
    );

    const result = await client.fetchPhoto('token-1');

    expect(result).toEqual({ ok: false, error: { kind: 'expired' }, requestId: 'photo-request-1' });
  });

  it('checks public error identity and preserves retry-after metadata', async () => {
    const response = new Response(
      JSON.stringify({
        schemaVersion: 'v1',
        requestId: 'photo-request-1',
        status: 429,
        code: 'RATE_LIMITED',
        message: 'retry later',
      }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '3' },
      },
    );
    const client = createJourneyPhotoClient(optionsFor(() => Promise.resolve(response)));

    const result = await client.fetchPhoto('token-1');

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'http', status: 429, retryAfterSeconds: 3 },
    });
  });

  it('rejects a response whose bounded body exceeds the mobile image limit', async () => {
    const response = new Response(new Uint8Array([1]), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(8 * 1024 * 1024 + 1),
        expires: 'Thu, 10 Sep 2026 12:05:00 GMT',
        [REQUEST_ID_HEADER]: 'photo-request-1',
      },
    });
    const client = createJourneyPhotoClient(optionsFor(() => Promise.resolve(response)));

    const result = await client.fetchPhoto('token-1');

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'contract') throw new Error('expected contract failure');
    expect(result.error.issues).toContain('photo response is too large');
  });

  it('bounds an unknown-length stream and cancels it at the limit', async () => {
    let cancelled = false;
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        expires: 'Thu, 10 Sep 2026 12:05:00 GMT',
        [REQUEST_ID_HEADER]: 'photo-request-1',
      },
    });
    const client = createJourneyPhotoClient(optionsFor(() => Promise.resolve(response)));

    const result = await client.fetchPhoto('token-1');

    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== 'contract') throw new Error('expected contract failure');
    expect(result.error.issues).toContain('photo response is too large');
    expect(cancelled).toBe(true);
  });

  it('bounds credential and body reads by the same deadline', async () => {
    const credentials = new Promise<{
      readonly appToken: string;
      readonly deviceId: string;
      readonly ownerCredential: string;
    }>(() => {});
    const credentialClient = createJourneyPhotoClient(
      optionsFor(vi.fn<ApiFetch>(), { credentials: () => credentials, timeoutMs: 10 }),
    );
    const credentialResult = await credentialClient.fetchPhoto('token-1');
    expect(credentialResult).toMatchObject({ ok: false, error: { kind: 'timeout' } });

    const response = new Response(
      new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }),
      {
        status: 200,
        headers: {
          'content-type': 'image/png',
          expires: 'Thu, 10 Sep 2026 12:05:00 GMT',
          [REQUEST_ID_HEADER]: 'photo-request-1',
        },
      },
    );
    const bodyClient = createJourneyPhotoClient(
      optionsFor(() => Promise.resolve(response), { timeoutMs: 10 }),
    );
    const bodyResult = await bodyClient.fetchPhoto('token-1');
    expect(bodyResult).toMatchObject({ ok: false, error: { kind: 'timeout' } });
  });

  it('cancels an in-flight read and ignores a later fetch resolution', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn<ApiFetch>(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const client = createJourneyPhotoClient(optionsFor(fetchImpl));
    const abort = new AbortController();
    const pending = client.fetchPhoto('token-1', { signal: abort.signal });
    abort.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    resolveFetch?.(responseFor());
  });
});
