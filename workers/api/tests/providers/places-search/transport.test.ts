import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleTextSearchTransport,
  type GoogleTextSearchTransportOptions,
} from '../../../src/providers/places-search/transport';
import {
  GOOGLE_TEXT_SEARCH_ENDPOINT,
  GOOGLE_TEXT_SEARCH_FIELD_MASK,
  type GoogleTextSearchRequest,
} from '../../../src/providers/places-search/types';

const request: GoogleTextSearchRequest = {
  textQuery: '静かなカフェ 渋谷',
  openNow: true,
  pageSize: 2,
};

const response = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), headers === undefined ? { status } : { status, headers });

const bodyText = (body: RequestInit['body']): string => {
  if (typeof body !== 'string') throw new Error('fixture body is not a string');
  return body;
};

const requestUrl = (value: RequestInfo | URL): string => {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.href : value.url;
};

const makeTransport = (
  fetcher: NonNullable<GoogleTextSearchTransportOptions['fetcher']>,
  overrides: Omit<GoogleTextSearchTransportOptions, 'fetcher'> = {},
) =>
  createGoogleTextSearchTransport({
    apiKey: 'test-key',
    fetcher,
    ...overrides,
  });

describe('Google Text Search transport', () => {
  it('sends the explicit field mask and a typed request body', async () => {
    const calls: { readonly url: RequestInfo | URL; readonly init: RequestInit | undefined }[] = [];
    const fetcher = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return Promise.resolve(
        response({
          places: [
            {
              id: 'google-place-1',
              displayName: { text: 'Cafe' },
              timeZone: { id: 'Asia/Tokyo' },
              attributions: [{ provider: 'Google Maps', providerUri: 'https://maps.google.com' }],
            },
          ],
          nextPageToken: 'provider-page-token',
        }),
      );
    };
    const transport = makeTransport(fetcher);

    await expect(transport.search(request)).resolves.toMatchObject({
      places: [{ id: 'google-place-1' }],
      nextPageToken: 'provider-page-token',
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('request was not sent');
    expect(requestUrl(call.url)).toBe(GOOGLE_TEXT_SEARCH_ENDPOINT);
    expect(call.init?.method).toBe('POST');
    expect(call.init?.redirect).toBe('manual');
    expect(call.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-goog-api-key': 'test-key',
      'x-goog-fieldmask': GOOGLE_TEXT_SEARCH_FIELD_MASK,
    });
    const body: unknown = JSON.parse(bodyText(call.init?.body));
    expect(body).toEqual(request);
    expect(bodyText(call.init?.body)).not.toContain('places/*');
    expect(GOOGLE_TEXT_SEARCH_ENDPOINT).toContain('/v1/places:searchText');
  });

  it('adds a location bias and page token only when supplied', async () => {
    let body: unknown;
    const fetcher = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      body = JSON.parse(bodyText(init?.body));
      return Promise.resolve(response({ places: [] }));
    };
    const transport = makeTransport(fetcher);

    await transport.search({
      ...request,
      pageToken: 'provider-token-only-at-the-transport-boundary',
      locationBias: {
        circle: {
          center: { latitude: 35.6595, longitude: 139.7005 },
          radius: 800,
        },
      },
    });

    expect(body).toEqual({
      textQuery: request.textQuery,
      openNow: true,
      pageSize: 2,
      pageToken: 'provider-token-only-at-the-transport-boundary',
      locationBias: {
        circle: {
          center: { latitude: 35.6595, longitude: 139.7005 },
          radius: 800,
        },
      },
    });
  });

  it('validates the response envelope while retaining malformed items for field normalization', async () => {
    const transport = makeTransport(() =>
      Promise.resolve(
        response({
          places: [
            { id: 'google-place-1', priceLevel: 3 },
            { id: 'google-place-2', priceLevel: 'PRICE_LEVEL_MODERATE' },
          ],
          nextPageToken: '',
        }),
      ),
    );

    await expect(transport.search(request)).resolves.toEqual({
      places: [
        { id: 'google-place-1', priceLevel: 3 },
        { id: 'google-place-2', priceLevel: 'PRICE_LEVEL_MODERATE' },
      ],
      nextPageToken: null,
    });
  });

  it('rejects missing keys and invalid transport requests before fetch', async () => {
    const fetcher = vi.fn((): Promise<Response> => Promise.resolve(response({ places: [] })));
    const noKey = createGoogleTextSearchTransport({ apiKey: '', fetcher });
    await expect(noKey.search(request)).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    await expect(noKey.search({ ...request, pageSize: 21 })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps rate limits, upstream failures, and malformed responses distinct', async () => {
    const rateLimited = makeTransport(() =>
      Promise.resolve(response({ error: { message: 'redacted' } }, 429, { 'retry-after': '1.25' })),
    );
    await expect(rateLimited.search(request)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 1_250,
    });

    const unavailable = makeTransport(() => Promise.resolve(response({}, 503)));
    await expect(unavailable.search(request)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
    });

    const redirected = makeTransport(() =>
      Promise.resolve(response({}, 302, { location: 'https://redirect.invalid' })),
    );
    await expect(redirected.search(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 302,
    });

    const malformed = makeTransport(() => Promise.resolve(response({ places: 'invalid' })));
    await expect(malformed.search(request)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('distinguishes caller cancellation from a transport timeout', async () => {
    vi.useFakeTimers();
    try {
      let started = false;
      const transport = makeTransport(
        (_url, init) => {
          started = true;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          });
        },
        { timeoutMs: 10 },
      );
      const controller = new AbortController();
      const pending = transport.search(request, controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(started).toBe(false);

      const timedOut = transport.search(request);
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await timedOutExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates only its typed provider error and never exposes response text', async () => {
    const transport = makeTransport(() => Promise.resolve(response({ bad: true }, 400)));
    await expect(transport.search(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Google Text Search failed: INVALID_REQUEST',
    });
  });
});
