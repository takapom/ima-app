import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { createGooglePlaceDetailsTransport } from '../../../src/providers/places-details/transport';
import {
  GOOGLE_PLACE_DETAILS_ENDPOINT,
  GOOGLE_PLACE_DETAILS_FIELDS,
  GooglePlaceDetailsError,
  GooglePlaceDetailsRequestSchema,
  googlePlaceDetailsFieldMask,
  type GooglePlaceDetailsTransportOptions,
  type GooglePlaceDetailsRequest,
} from '../../../src/providers/places-details/types';

const request: GooglePlaceDetailsRequest = {
  placeId: 'ChIJfixture_1',
  fields: ['identity', 'opening_hours'],
};

const response = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), headers === undefined ? { status } : { status, headers });

const requestUrl = (value: RequestInfo | URL): string => {
  if (typeof value === 'string') return value;
  return value instanceof URL ? value.href : value.url;
};

const makeTransport = (
  fetcher: NonNullable<GooglePlaceDetailsTransportOptions['fetcher']>,
  overrides: Omit<GooglePlaceDetailsTransportOptions, 'fetcher'> = {},
) =>
  createGooglePlaceDetailsTransport({
    apiKey: 'test-key-do-not-log',
    fetcher,
    ...overrides,
  });

describe('Google Place Details transport', () => {
  it('sends one GET with an explicit supported field mask and no request body', async () => {
    const calls: { readonly url: RequestInfo | URL; readonly init: RequestInit | undefined }[] = [];
    const fetcher = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return Promise.resolve(
        response({
          id: request.placeId,
          displayName: { text: 'Fixture Cafe' },
          currentOpeningHours: { periods: [] },
          providerOnlyValue: 'must-stay-at-raw-boundary',
        }),
      );
    };
    const transport = makeTransport(fetcher);

    await expect(transport.read(request)).resolves.toMatchObject({
      placeId: request.placeId,
      fields: request.fields,
      body: { providerOnlyValue: 'must-stay-at-raw-boundary' },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('details request was not sent');
    expect(requestUrl(call.url)).toBe(`${GOOGLE_PLACE_DETAILS_ENDPOINT}/${request.placeId}`);
    expect(requestUrl(call.url)).not.toContain('test-key-do-not-log');
    expect(call.init?.method).toBe('GET');
    expect(call.init?.body).toBeUndefined();
    expect(call.init?.redirect).toBe('manual');
    expect(call.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-goog-api-key': 'test-key-do-not-log',
      'x-goog-fieldmask': googlePlaceDetailsFieldMask(request.fields),
    });
  });

  it('uses only the requested logical fields while retaining required id and attribution metadata', () => {
    const mask = googlePlaceDetailsFieldMask(['contact']);
    expect(mask.split(',')).toEqual([
      'id',
      'googleMapsUri',
      'websiteUri',
      'nationalPhoneNumber',
      'internationalPhoneNumber',
      'attributions',
    ]);
    expect(mask).not.toContain('currentOpeningHours');
    expect(mask).not.toContain('priceLevel');
    expect(mask).not.toContain('photos');
    expect(mask).not.toContain('*');
    for (const field of GOOGLE_PLACE_DETAILS_FIELDS) {
      const singleFieldMask = googlePlaceDetailsFieldMask([field]);
      expect(singleFieldMask).toContain('id');
      expect(singleFieldMask).toContain('googleMapsUri');
      expect(singleFieldMask).toContain('attributions');
    }
  });

  it('does not follow a moved place; the field normalizer receives the moved metadata', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        response({
          id: request.placeId,
          businessStatus: 'CLOSED_PERMANENTLY',
          movedPlace: 'places/ChIJmoved',
          movedPlaceId: 'ChIJmoved',
        }),
      ),
    );
    const transport = makeTransport(fetcher);

    const result = await transport.read({ placeId: request.placeId, fields: ['identity'] });
    expect(result.body).toMatchObject({ movedPlace: 'places/ChIJmoved' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns a raw object for field-level normalization instead of rejecting malformed unrelated fields', async () => {
    const transport = makeTransport(() =>
      Promise.resolve(
        response({
          id: request.placeId,
          displayName: { text: 'Valid identity' },
          priceLevel: 123,
          photos: 'malformed-unrequested-field',
        }),
      ),
    );

    const result = await transport.read({ placeId: request.placeId, fields: ['identity'] });
    expect(result.body).toMatchObject({ priceLevel: 123 });
  });

  it('rejects malformed JSON and non-object response bodies without exposing upstream text', async () => {
    const malformed = makeTransport(() =>
      Promise.resolve(new Response('{"bad":', { status: 200 })),
    );
    await expect(malformed.read(request)).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
      message: 'Google Place Details failed: SCHEMA_MISMATCH',
    });

    const arrayBody = makeTransport(() => Promise.resolve(response(['not', 'a', 'place'])));
    await expect(arrayBody.read(request)).rejects.toBeInstanceOf(GooglePlaceDetailsError);
  });

  it('keeps missing key, empty fields, 404, rate limit, and upstream failures typed', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response({})));
    const noKey = createGooglePlaceDetailsTransport({ apiKey: '', fetcher });
    await expect(noKey.read(request)).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    await expect(noKey.read({ placeId: request.placeId, fields: [] })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetcher).not.toHaveBeenCalled();

    const notFound = makeTransport(() => Promise.resolve(response({ error: 'secret' }, 404)));
    await expect(notFound.read(request)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const redirected = makeTransport(() =>
      Promise.resolve(response({}, 302, { location: 'https://redirect.invalid' })),
    );
    await expect(redirected.read(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 302,
    });

    const limited = makeTransport(() =>
      Promise.resolve(response({ error: 'secret' }, 429, { 'retry-after': '1.25' })),
    );
    await expect(limited.read(request)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 1_250,
    });

    const unavailable = makeTransport(() => Promise.resolve(response({ error: 'secret' }, 503)));
    await expect(unavailable.read(request)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
    });
  });

  it('rejects unsupported fields at the request schema boundary', () => {
    expect(
      v.safeParse(GooglePlaceDetailsRequestSchema, {
        placeId: request.placeId,
        fields: ['facilities'],
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(GooglePlaceDetailsRequestSchema, {
        placeId: 'places/ChIJresource',
        fields: ['identity'],
      }).success,
    ).toBe(false);
  });

  it('maps caller abort to CANCELLED and forwards abort only to fetch', async () => {
    let forwardedSignal: AbortSignal | undefined;
    const pendingResponse = new Promise<Response>(() => undefined);
    const transport = makeTransport((_url: RequestInfo | URL, init?: RequestInit) => {
      forwardedSignal = init?.signal ?? undefined;
      return pendingResponse;
    });
    const controller = new AbortController();
    const pending = transport.read(request, controller.signal);
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it('times out while reading the response body and aborts the upstream signal', async () => {
    vi.useFakeTimers();
    try {
      let forwardedSignal: AbortSignal | undefined;
      const body = new Response('{}');
      vi.spyOn(body, 'text').mockImplementation(() => new Promise<string>(() => undefined));
      const transport = makeTransport(
        (_url: RequestInfo | URL, init?: RequestInit) => {
          forwardedSignal = init?.signal ?? undefined;
          return Promise.resolve(body);
        },
        { timeoutMs: 25 },
      );
      const pending = transport.read(request);
      const timeoutExpectation = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25);
      await timeoutExpectation;
      expect(forwardedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
