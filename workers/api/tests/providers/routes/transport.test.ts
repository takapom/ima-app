import { describe, expect, it, vi } from 'vitest';
import {
  createGoogleRouteMatrixTransport,
  parseGoogleRouteMatrixResponse,
} from '../../../src/providers/routes/transport';
import {
  GOOGLE_ROUTE_MATRIX_ENDPOINT,
  GOOGLE_ROUTE_MATRIX_FIELD_MASK,
  GoogleRouteMatrixError,
  type GoogleRouteMatrixRequest,
} from '../../../src/providers/routes/types';

const request: GoogleRouteMatrixRequest = {
  origins: [
    { ref: 'current', coordinates: { lat: 35.6595, lng: 139.7005 } },
    { ref: 'shop-1', coordinates: { lat: 35.658, lng: 139.7016 } },
  ],
  destinations: [
    { ref: 'shop-1', coordinates: { lat: 35.658, lng: 139.7016 } },
    { ref: 'station-1', coordinates: { lat: 35.6467, lng: 139.71 } },
  ],
  departureTime: '2026-09-10T09:00:00Z',
};

const response = (body: unknown, status = 200, headers?: HeadersInit): Response => {
  const init: ResponseInit = { status };
  if (headers !== undefined) init.headers = headers;
  return new Response(JSON.stringify(body), init);
};

const route = (originIndex: number, destinationIndex: number, duration = '120s') => ({
  originIndex,
  destinationIndex,
  status: {},
  condition: 'ROUTE_EXISTS',
  distanceMeters: 400,
  duration,
});

describe('Google Route Matrix transport', () => {
  it('sends a fixed WALK request and preserves directed endpoint positions', async () => {
    const calls: { readonly url: RequestInfo | URL; readonly init: RequestInit | undefined }[] = [];
    const fetcher = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return Promise.resolve(response([route(1, 0), route(0, 1), route(0, 0), route(1, 1)]));
    };
    const transport = createGoogleRouteMatrixTransport({ apiKey: 'test-key', fetcher });

    await expect(transport.compute(request)).resolves.toHaveLength(4);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('route request was not sent');
    expect(call.url).toBe(GOOGLE_ROUTE_MATRIX_ENDPOINT);
    expect(call.init?.method).toBe('POST');
    expect(call.init?.redirect).toBe('manual');
    expect(call.init?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'x-goog-api-key': 'test-key',
      'x-goog-fieldmask': GOOGLE_ROUTE_MATRIX_FIELD_MASK,
    });
    const body = call.init?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('route request body was not JSON');
    expect(JSON.parse(body)).toEqual({
      origins: [
        { waypoint: { location: { latLng: { latitude: 35.6595, longitude: 139.7005 } } } },
        { waypoint: { location: { latLng: { latitude: 35.658, longitude: 139.7016 } } } },
      ],
      destinations: [
        { waypoint: { location: { latLng: { latitude: 35.658, longitude: 139.7016 } } } },
        { waypoint: { location: { latLng: { latitude: 35.6467, longitude: 139.71 } } } },
      ],
      travelMode: 'WALK',
      departureTime: '2026-09-10T09:00:00Z',
    });
  });

  it('serializes an opaque place ID waypoint without exposing it to Core values', async () => {
    let body: unknown;
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: (_url, init) => {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        return Promise.resolve(response([route(0, 0)]));
      },
    });
    await transport.compute({
      origins: [{ ref: 'current', coordinates: { lat: 35.6595, lng: 139.7005 } }],
      destinations: [{ ref: 'candidate-1', placeId: '-fixture_place' }],
    });
    expect(body).toEqual({
      origins: [{ waypoint: { location: { latLng: { latitude: 35.6595, longitude: 139.7005 } } } }],
      destinations: [{ waypoint: { placeId: '-fixture_place' } }],
      travelMode: 'WALK',
    });
  });

  it('rejects invalid matrices before making an HTTP call', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response([])));
    const transport = createGoogleRouteMatrixTransport({ apiKey: 'test-key', fetcher });
    await expect(transport.compute({ origins: [], destinations: [] })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(
      transport.compute({
        ...request,
        origins: [...request.origins, ...request.origins],
        destinations: [...request.destinations, ...request.destinations],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      transport.compute({
        ...request,
        origins: request.origins.slice(0, 1).concat(request.origins.slice(0, 1)),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps missing keys, rate limits, upstream failures, and schema errors distinct', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response([])));
    await expect(
      createGoogleRouteMatrixTransport({ apiKey: '', fetcher }).compute(request),
    ).rejects.toMatchObject({ code: 'MISSING_API_KEY' });

    const rateLimited = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () =>
        Promise.resolve(response({ error: 'redacted' }, 429, { 'retry-after': '1.25' })),
    });
    await expect(rateLimited.compute(request)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 1_250,
    });

    const unavailable = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () => Promise.resolve(response({}, 503)),
    });
    await expect(unavailable.compute(request)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
    });

    const redirected = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () => Promise.resolve(response({}, 302, { location: 'https://redirect.invalid' })),
    });
    await expect(redirected.compute(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 302,
    });

    const malformed = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: () => Promise.resolve(response({ elements: [] })),
    });
    await expect(malformed.compute(request)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('does not retry and does not expose upstream response text', async () => {
    const calls: (RequestInfo | URL)[] = [];
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'test-key',
      fetcher: (url) => {
        calls.push(url);
        return Promise.resolve(response({ bad: 'secret upstream detail' }, 400));
      },
    });
    await expect(transport.compute(request)).rejects.toBeInstanceOf(GoogleRouteMatrixError);
    await expect(transport.compute(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toHaveLength(2);
    try {
      await transport.compute(request);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GoogleRouteMatrixError);
      if (!(error instanceof GoogleRouteMatrixError)) return;
      expect(error.message).not.toContain('secret upstream detail');
    }
  });

  it('maps caller cancellation and body timeout through the Worker signal', async () => {
    vi.useFakeTimers();
    try {
      let started = false;
      const transport = createGoogleRouteMatrixTransport({
        apiKey: 'test-key',
        timeoutMs: 10,
        fetcher: (_url, _init) => {
          started = true;
          return Promise.resolve(
            new Response(new ReadableStream({ start() {} }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      });
      const controller = new AbortController();
      const cancelled = transport.compute(request, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(started).toBe(false);

      const timedOut = transport.compute(request);
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await timedOutExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates raw element fields without retaining provider messages', () => {
    expect(parseGoogleRouteMatrixResponse([route(0, 0)])).toEqual([route(0, 0)]);
    expect(
      parseGoogleRouteMatrixResponse([{ condition: 'ROUTE_EXISTS', duration: '1s' }]),
    ).toMatchObject([{ originIndex: 0, destinationIndex: 0 }]);
    expect(
      parseGoogleRouteMatrixResponse([{ originIndex: 0, destinationIndex: 0, duration: 'bad' }]),
    ).toMatchObject([{ parseError: 'INVALID_ELEMENT' }]);
  });
});
