import { describe, expect, it, vi } from 'vitest';
import {
  APP_TOKEN_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  REQUEST_ID_HEADER,
} from '@ima/contracts';
import { createJourneyPhotoClient } from './photo-client';
import type { ApiClientOptions, ApiFetch } from './api';

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
