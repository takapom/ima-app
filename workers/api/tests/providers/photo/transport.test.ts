import { describe, expect, it, vi } from 'vitest';
import {
  createGooglePhotoMediaTransport,
  type GooglePhotoMediaTransportOptions,
} from '../../../src/providers/photo/transport';
import type { RuntimeProviderTransportObserver } from '../../../src/providers/telemetry/runtime-provider-trace-contract';

const PHOTO_REF = 'places/ChIJfixture/photos/A1B2C3';
const API_KEY = 'photo-key-fixture';
const PHOTO_URI = 'https://lh3.googleusercontent.com/p/fixture=w800-h600';

const metadata = (photoUri: string, status = 200): Response =>
  new Response(JSON.stringify({ photoUri }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const image = (
  body: BodyInit | null = new Uint8Array([1, 2, 3]),
  contentType = 'image/jpeg',
  headers: HeadersInit = {},
): Response =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': contentType, ...headers },
  });

const requestUrl = (value: RequestInfo | URL): URL =>
  new URL(typeof value === 'string' ? value : value instanceof URL ? value.href : value.url);

const makeTransport = (
  fetcher: NonNullable<GooglePhotoMediaTransportOptions['fetcher']>,
  overrides: Omit<GooglePhotoMediaTransportOptions, 'fetcher'> = {},
) =>
  createGooglePhotoMediaTransport({
    apiKey: API_KEY,
    fetcher,
    ...overrides,
  });

describe('Google Photo media transport', () => {
  it('records metadata and image fetch completion while keeping stream completion on the image call', async () => {
    const completions: { provider: string; status: string; error?: unknown }[] = [];
    const observer: RuntimeProviderTransportObserver = {
      begin: (input) => ({
        complete: (completion) => {
          completions.push({ provider: input.provider, ...completion });
        },
      }),
    };
    const transport = makeTransport((_url, init) =>
      Promise.resolve(
        init?.headers && JSON.stringify(init.headers).includes('application/json')
          ? metadata(PHOTO_URI)
          : image(),
      ),
    );

    const result = await transport.read(PHOTO_REF, undefined, observer);
    expect(completions).toEqual([{ provider: 'photo', status: 'ok' }]);
    await new Response(result.body).arrayBuffer();
    expect(completions).toHaveLength(2);
    expect(completions.every((completion) => completion.status === 'ok')).toBe(true);
  });

  it('classifies metadata failure and image size failure on their respective fetch calls', async () => {
    const metadataCompletions: { provider: string; status: string; error?: unknown }[] = [];
    const metadataObserver: RuntimeProviderTransportObserver = {
      begin: (input) => ({
        complete: (completion) =>
          metadataCompletions.push({ provider: input.provider, ...completion }),
      }),
    };
    await expect(
      makeTransport(() => Promise.resolve(metadata(PHOTO_URI, 404))).read(
        PHOTO_REF,
        undefined,
        metadataObserver,
      ),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(metadataCompletions).toHaveLength(1);
    expect(metadataCompletions[0]?.error).toMatchObject({ code: 'EXPIRED' });

    const imageCompletions: { provider: string; status: string; error?: unknown }[] = [];
    const imageObserver: RuntimeProviderTransportObserver = {
      begin: (input) => ({
        complete: (completion) =>
          imageCompletions.push({ provider: input.provider, ...completion }),
      }),
    };
    const oversized = makeTransport(
      (_url, init) =>
        Promise.resolve(
          init?.headers && JSON.stringify(init.headers).includes('application/json')
            ? metadata(PHOTO_URI)
            : image(new Uint8Array([1, 2, 3]), 'image/jpeg', { 'content-length': '3' }),
        ),
      { maxBytes: 2 },
    );
    await expect(oversized.read(PHOTO_REF, undefined, imageObserver)).rejects.toMatchObject({
      code: 'RESULT_TOO_LARGE',
    });
    expect(imageCompletions).toHaveLength(2);
    expect(imageCompletions[0]?.status).toBe('ok');
    expect(imageCompletions[1]?.error).toMatchObject({ code: 'RESULT_TOO_LARGE' });
  });

  it('records timeout and caller cancellation without creating a preflight call', async () => {
    vi.useFakeTimers();
    try {
      const timeoutCompletions: { provider: string; status: string; error?: unknown }[] = [];
      const timeoutObserver: RuntimeProviderTransportObserver = {
        begin: (input) => ({
          complete: (completion) =>
            timeoutCompletions.push({ provider: input.provider, ...completion }),
        }),
      };
      const pending = makeTransport(
        () =>
          Promise.resolve(
            new Response(new ReadableStream<Uint8Array>(), {
              headers: { 'content-type': 'application/json' },
            }),
          ),
        { timeoutMs: 10 },
      ).read(PHOTO_REF, undefined, timeoutObserver);
      const timeoutExpectation = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await timeoutExpectation;
      expect(timeoutCompletions[0]?.error).toMatchObject({ code: 'TIMEOUT' });

      const cancellationCompletions: { provider: string; status: string; error?: unknown }[] = [];
      const cancellationObserver: RuntimeProviderTransportObserver = {
        begin: (input) => ({
          complete: (completion) =>
            cancellationCompletions.push({ provider: input.provider, ...completion }),
        }),
      };
      const caller = new AbortController();
      const result = await makeTransport((_url, init) => {
        if (init?.headers && JSON.stringify(init.headers).includes('application/json')) {
          return Promise.resolve(metadata(PHOTO_URI));
        }
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>(), {
            headers: { 'content-type': 'image/jpeg' },
          }),
        );
      }).read(PHOTO_REF, caller.signal, cancellationObserver);
      const read = result.body.getReader().read();
      const cancellationExpectation = expect(read).rejects.toMatchObject({ code: 'CANCELLED' });
      caller.abort();
      await cancellationExpectation;
      expect(cancellationCompletions[0]?.status).toBe('ok');
      expect(cancellationCompletions[1]?.error).toMatchObject({ code: 'CANCELLED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the API key in the metadata header and streams the fixed-host image without it', async () => {
    const calls: { readonly url: RequestInfo | URL; readonly init: RequestInit | undefined }[] = [];
    const transport = makeTransport((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(calls.length === 1 ? metadata(PHOTO_URI) : image());
    });

    const result = await transport.read(PHOTO_REF);
    expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    if (first === undefined || second === undefined) throw new Error('photo calls missing');
    const firstUrl = requestUrl(first.url);
    expect(firstUrl.origin).toBe('https://places.googleapis.com');
    expect(firstUrl.pathname).toBe('/v1/places/ChIJfixture/photos/A1B2C3/media');
    expect(firstUrl.searchParams.get('maxWidthPx')).toBe('1600');
    expect(firstUrl.searchParams.get('skipHttpRedirect')).toBe('true');
    expect(firstUrl.searchParams.has('key')).toBe(false);
    expect(first.init?.redirect).toBe('manual');
    expect(first.init?.headers).toEqual({
      accept: 'application/json',
      'x-goog-api-key': API_KEY,
    });
    expect(requestUrl(second.url).toString()).toBe(PHOTO_URI);
    expect(second.init?.headers).toEqual({ accept: 'image/*' });
    expect(JSON.stringify(second.init?.headers)).not.toContain(API_KEY);
  });

  it('rejects redirect destinations with another host, credentials, or a non-standard port', async () => {
    for (const photoUri of [
      'https://evil.example/photo',
      'https://user:pass@lh3.googleusercontent.com/photo',
      'https://lh3.googleusercontent.com:8443/photo',
    ]) {
      const fetcher = vi.fn((_url: RequestInfo | URL): Promise<Response> =>
        Promise.resolve(fetcher.mock.calls.length === 1 ? metadata(photoUri) : image()),
      );
      const transport = makeTransport(fetcher);
      await expect(transport.read(PHOTO_REF)).rejects.toMatchObject({ code: 'REDIRECT_REJECTED' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects an upstream HTTP redirect before following it', async () => {
    let cancelCount = 0;
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
    });
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(redirectBody, {
          status: 302,
          headers: { location: PHOTO_URI },
        }),
      ),
    );

    await expect(makeTransport(fetcher).read(PHOTO_REF)).rejects.toMatchObject({
      code: 'REDIRECT_REJECTED',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancelCount).toBe(1);
  });

  it('fails before fetch for missing keys or invalid provider names', async () => {
    const fetcher = vi.fn(() => Promise.resolve(metadata(PHOTO_URI)));
    const observer: RuntimeProviderTransportObserver = {
      begin: vi.fn(() => ({ complete: vi.fn() })),
    };
    await expect(
      createGooglePhotoMediaTransport({ apiKey: '', fetcher }).read(PHOTO_REF, undefined, observer),
    ).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(observer.begin).not.toHaveBeenCalled();

    const invalidFetcher = vi.fn(() => Promise.resolve(metadata(PHOTO_URI)));
    await expect(
      makeTransport(invalidFetcher).read('https://provider/photo', undefined, observer),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(invalidFetcher).not.toHaveBeenCalled();
    expect(observer.begin).not.toHaveBeenCalled();

    const caller = new AbortController();
    caller.abort();
    const abortedFetcher = vi.fn(() => Promise.resolve(metadata(PHOTO_URI)));
    await expect(
      makeTransport(abortedFetcher).read(PHOTO_REF, caller.signal, observer),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(abortedFetcher).not.toHaveBeenCalled();
    expect(observer.begin).not.toHaveBeenCalled();
  });

  it('bounds metadata JSON and preserves typed upstream status failures', async () => {
    const oversized = makeTransport(
      () => Promise.resolve(metadata(`https://lh3.googleusercontent.com/${'x'.repeat(100)}`)),
      { metadataMaxBytes: 16 },
    );
    await expect(oversized.read(PHOTO_REF)).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' });

    await expect(
      makeTransport(() =>
        Promise.resolve(
          new Response('{"photoUri":', {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ).read(PHOTO_REF),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    await expect(
      makeTransport(() =>
        Promise.resolve(
          new Response(JSON.stringify({}), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ).read(PHOTO_REF),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

    await expect(
      makeTransport(() => Promise.resolve(metadata(PHOTO_URI, 404))).read(PHOTO_REF),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(
      makeTransport(() =>
        Promise.resolve(
          new Response('upstream-secret', {
            status: 429,
            headers: { 'retry-after': '1.25' },
          }),
        ),
      ).read(PHOTO_REF),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1_250 });
    await expect(
      makeTransport(() => Promise.resolve(new Response('upstream-secret', { status: 503 }))).read(
        PHOTO_REF,
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('cancels an oversized or unsupported image before returning a body', async () => {
    const oversized = makeTransport(
      (_url, init) =>
        Promise.resolve(
          init?.headers && JSON.stringify(init.headers).includes('application/json')
            ? metadata(PHOTO_URI)
            : image(new Uint8Array([1, 2, 3]), 'image/jpeg', { 'content-length': '3' }),
        ),
      { maxBytes: 2 },
    );
    await expect(oversized.read(PHOTO_REF)).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' });

    let cancelCount = 0;
    const unsupportedBody = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1;
      },
    });
    const unsupported = makeTransport((_url, init) =>
      Promise.resolve(
        init?.headers && JSON.stringify(init.headers).includes('application/json')
          ? metadata(PHOTO_URI)
          : new Response(unsupportedBody, { headers: { 'content-type': 'image/tiff' } }),
      ),
    );
    await expect(unsupported.read(PHOTO_REF)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
    expect(cancelCount).toBe(1);
  });

  it('enforces the byte limit while consuming the returned stream', async () => {
    const completions: { provider: string; status: string; error?: unknown }[] = [];
    const observer: RuntimeProviderTransportObserver = {
      begin: (input) => ({
        complete: (completion) => completions.push({ provider: input.provider, ...completion }),
      }),
    };
    const transport = makeTransport(
      (_url, init) =>
        Promise.resolve(
          init?.headers && JSON.stringify(init.headers).includes('application/json')
            ? metadata(PHOTO_URI)
            : new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array([1, 2]));
                    controller.enqueue(new Uint8Array([3, 4]));
                    controller.close();
                  },
                }),
                { headers: { 'content-type': 'image/png' } },
              ),
        ),
      { maxBytes: 3 },
    );
    const result = await transport.read(PHOTO_REF, undefined, observer);
    const reader = result.body.getReader();
    await expect(reader.read()).resolves.toMatchObject({ value: new Uint8Array([1, 2]) });
    await expect(reader.read()).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE' });
    expect(completions).toHaveLength(2);
    expect(completions[0]?.status).toBe('ok');
    expect(completions[1]?.error).toMatchObject({ code: 'RESULT_TOO_LARGE' });
  });

  it('maps caller cancellation and deadline expiry during image streaming', async () => {
    vi.useFakeTimers();
    try {
      let metadataCancelCount = 0;
      const pendingMetadata = new ReadableStream<Uint8Array>({
        cancel() {
          metadataCancelCount += 1;
        },
      });
      const metadataTimeout = makeTransport(
        (url) =>
          Promise.resolve(
            requestUrl(url).origin === 'https://places.googleapis.com'
              ? new Response(pendingMetadata, { headers: { 'content-type': 'application/json' } })
              : image(),
          ),
        { timeoutMs: 25 },
      );
      const pendingMetadataRead = metadataTimeout.read(PHOTO_REF);
      const metadataExpectation = expect(pendingMetadataRead).rejects.toMatchObject({
        code: 'TIMEOUT',
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await metadataExpectation;
      expect(metadataCancelCount).toBe(1);

      let imageSignal: AbortSignal | undefined;
      let imageCancelCount = 0;
      const fetcher = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (requestUrl(url).origin === 'https://places.googleapis.com') {
          return Promise.resolve(metadata(PHOTO_URI));
        }
        imageSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                imageCancelCount += 1;
              },
            }),
            { headers: { 'content-type': 'image/jpeg' } },
          ),
        );
      };
      const transport = makeTransport(fetcher, { timeoutMs: 25 });
      const caller = new AbortController();
      const result = await transport.read(PHOTO_REF, caller.signal);
      const pending = result.body.getReader().read();
      const cancellationExpectation = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      caller.abort();
      await cancellationExpectation;
      expect(imageSignal?.aborted).toBe(true);

      const timed = await transport.read(PHOTO_REF);
      const timeoutPending = timed.body.getReader().read();
      const timeoutExpectation = expect(timeoutPending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25);
      await timeoutExpectation;
      expect(imageCancelCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a response body when cancellation races response delivery', async () => {
    const caller = new AbortController();
    let cancelCount = 0;
    const fetcher = (_url: RequestInfo | URL): Promise<Response> => {
      caller.abort();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCount += 1;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const transport = makeTransport(fetcher);

    await expect(transport.read(PHOTO_REF, caller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(cancelCount).toBe(1);

    const imageCaller = new AbortController();
    let imageCancelCount = 0;
    let imageCall = 0;
    const imageRace = makeTransport((_url) => {
      imageCall += 1;
      if (imageCall === 1) return Promise.resolve(metadata(PHOTO_URI));
      imageCaller.abort();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              imageCancelCount += 1;
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
      );
    });
    const imageResult = await imageRace.read(PHOTO_REF, imageCaller.signal);
    await expect(imageResult.body.getReader().read()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(imageCancelCount).toBe(1);
  });
});
