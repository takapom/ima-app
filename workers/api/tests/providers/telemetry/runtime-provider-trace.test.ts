import { describe, expect, it, vi } from 'vitest';
import { createGooglePlaceDetailsTransport } from '../../../src/providers/places-details/transport';
import type { GooglePlaceDetailsRequest } from '../../../src/providers/places-details/types';
import { createGoogleTextSearchTransport } from '../../../src/providers/places-search/transport';
import type { GoogleTextSearchRequest } from '../../../src/providers/places-search/types';
import { createGoogleRouteMatrixTransport } from '../../../src/providers/routes/transport';
import { PhotoProviderError } from '../../../src/providers/photo/media';
import {
  routeElementCount,
  type GoogleRouteMatrixRequest,
} from '../../../src/providers/routes/types';
import {
  createBestEffortRuntimeProviderTraceSink,
  createRuntimeProviderTransportObserver,
  traceRecordForRuntimeProvider,
  type RuntimeProviderTrace,
  type RuntimeProviderTraceOptions,
} from '../../../src/providers/telemetry/runtime-provider-trace';
import type { RuntimeProviderTransportObserver } from '../../../src/providers/telemetry/runtime-provider-trace-contract';

const searchRequest: GoogleTextSearchRequest = {
  textQuery: 'PROVIDER_REQUEST_CANARY quiet cafe',
  openNow: true,
  pageSize: 2,
};

const detailsRequest: GooglePlaceDetailsRequest = {
  placeId: 'provider-place-canary',
  fields: ['identity'],
};

const routeRequest: GoogleRouteMatrixRequest = {
  origins: [
    { ref: 'origin-1', coordinates: { lat: 35.6595, lng: 139.7005 } },
    { ref: 'origin-2', coordinates: { lat: 35.658, lng: 139.7016 } },
  ],
  destinations: [
    { ref: 'destination-1', coordinates: { lat: 35.6467, lng: 139.71 } },
    { ref: 'destination-2', coordinates: { lat: 35.647, lng: 139.711 } },
    { ref: 'destination-3', coordinates: { lat: 35.648, lng: 139.712 } },
  ],
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

const baseTraceOptions = (
  sink: (trace: RuntimeProviderTrace) => void | Promise<void>,
  overrides: Partial<Omit<RuntimeProviderTraceOptions, 'sink'>> = {},
): RuntimeProviderTraceOptions => ({
  ownerScopeRef: 'owner-provider-trace',
  threadId: 'thread-provider-trace',
  turnId: 'turn-provider-trace',
  revision: 4,
  clock: () => '2026-09-11T00:00:00.000Z',
  monotonicNow: () => 100,
  sink,
  ...overrides,
});

const fetcherFor =
  (): typeof fetch =>
  (url: RequestInfo | URL): Promise<Response> => {
    const value = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (value.endsWith(':searchText')) return Promise.resolve(jsonResponse({ places: [] }));
    if (value.includes('/v1/places/')) {
      return Promise.resolve(jsonResponse({ id: detailsRequest.placeId }));
    }
    if (value.endsWith('distanceMatrix/v2:computeRouteMatrix')) {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.resolve(jsonResponse({}, 404));
  };

describe('runtime provider transport trace', () => {
  it('records one trace at each real Search, Details, and Routes transport boundary', async () => {
    const traces: RuntimeProviderTrace[] = [];
    const options = baseTraceOptions((trace) => {
      traces.push(trace);
    });
    const observer = createRuntimeProviderTransportObserver(options);
    const fetcher = fetcherFor();
    const search = createGoogleTextSearchTransport({
      apiKey: 'provider-key-canary',
      fetcher,
      observer,
    });
    const details = createGooglePlaceDetailsTransport({
      apiKey: 'provider-key-canary',
      fetcher,
      observer,
    });
    const routes = createGoogleRouteMatrixTransport({
      apiKey: 'provider-key-canary',
      fetcher,
      observer,
    });

    await search.search(searchRequest);
    await details.read(detailsRequest);
    await routes.compute(routeRequest);

    expect(traces).toHaveLength(3);
    expect(traces.map((trace) => trace.provider)).toEqual(['places', 'places', 'routes']);
    expect(traces.every((trace) => trace.status === 'ok' && trace.resultCode === 'OK')).toBe(true);
    expect(traces.find((trace) => trace.provider === 'routes')).toMatchObject({
      apiElementCount: 6,
    });
    expect(JSON.stringify(traces)).not.toContain('PROVIDER_REQUEST_CANARY');
    expect(JSON.stringify(traces)).not.toContain('provider-place-canary');
    expect(JSON.stringify(traces)).not.toContain('provider-key-canary');
  });

  it('counts route elements only after the transport request schema has passed', async () => {
    const traces: RuntimeProviderTrace[] = [];
    const observer = createRuntimeProviderTransportObserver(
      baseTraceOptions((trace) => {
        traces.push(trace);
      }),
    );
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse([])));
    const routes = createGoogleRouteMatrixTransport({
      apiKey: 'provider-key-canary',
      fetcher,
      observer,
    });
    const missingKeyRoutes = createGoogleRouteMatrixTransport({
      fetcher,
      observer,
    });

    await expect(missingKeyRoutes.compute(routeRequest)).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(traces).toHaveLength(0);
    await routes.compute(routeRequest);
    await expect(routes.compute({ origins: [], destinations: [] })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ apiElementCount: 6 });
    expect(routeElementCount(routeRequest)).toBe(6);
  });

  it('classifies typed timeout, cancellation, and rate-limit failures without changing errors', async () => {
    vi.useFakeTimers();
    try {
      const traces: RuntimeProviderTrace[] = [];
      const options = baseTraceOptions((trace) => {
        traces.push(trace);
      });
      const observer = createRuntimeProviderTransportObserver(options);
      const timeoutTransport = createGoogleTextSearchTransport({
        apiKey: 'provider-key-canary',
        timeoutMs: 10,
        observer,
        fetcher: () => new Promise<Response>(() => undefined),
      });
      const timeoutResult = timeoutTransport.search(searchRequest);
      const timeoutExpectation = expect(timeoutResult).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await timeoutExpectation;
      expect(traces[0]).toMatchObject({
        status: 'error',
        resultCode: 'PROVIDER_TIMEOUT',
      });

      const controller = new AbortController();
      controller.abort();
      const fetcher = vi.fn(() => Promise.resolve(jsonResponse({ places: [] })));
      const cancelledTransport = createGoogleTextSearchTransport({
        apiKey: 'provider-key-canary',
        fetcher,
        observer,
      });
      await expect(
        cancelledTransport.search(searchRequest, controller.signal),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(traces).toHaveLength(1);

      const rateLimitedTransport = createGoogleTextSearchTransport({
        apiKey: 'provider-key-canary',
        observer,
        fetcher: () => Promise.resolve(jsonResponse({ error: 'PROVIDER_BODY_CANARY' }, 429)),
      });
      await expect(rateLimitedTransport.search(searchRequest)).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(traces[1]).toMatchObject({ status: 'error', resultCode: 'RATE_LIMITED' });
      expect(JSON.stringify(traces)).not.toContain('PROVIDER_BODY_CANARY');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores only a fixed internal outcome for an unexpected provider error', () => {
    const traces: RuntimeProviderTrace[] = [];
    const providerError = new Error('PROVIDER_SECRET_CANARY');
    const observer = createRuntimeProviderTransportObserver(
      baseTraceOptions((trace) => {
        traces.push(trace);
      }),
    );
    const call = observer.begin({ provider: 'places' });
    call.complete({ status: 'error', error: providerError });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'error', resultCode: 'INTERNAL' });
    expect(JSON.stringify(traces)).not.toContain('PROVIDER_SECRET_CANARY');
  });

  it('isolates observer hook failures from the real provider result and error', async () => {
    const beginFailureObserver: RuntimeProviderTransportObserver = {
      begin: () => {
        throw new Error('BEGIN_OBSERVER_CANARY');
      },
    };
    const successFetcher = vi.fn(() => Promise.resolve(jsonResponse({ places: [] })));
    const successTransport = createGoogleTextSearchTransport({
      apiKey: 'provider-key-canary',
      fetcher: successFetcher,
      observer: beginFailureObserver,
    });

    await expect(successTransport.search(searchRequest)).resolves.toEqual({
      places: [],
      nextPageToken: null,
    });
    expect(successFetcher).toHaveBeenCalledTimes(1);

    const completeFailureObserver: RuntimeProviderTransportObserver = {
      begin: () => ({
        complete: () => {
          throw new Error('COMPLETE_OBSERVER_CANARY');
        },
      }),
    };
    const rateFetcher = vi.fn(() => Promise.resolve(jsonResponse({}, 429)));
    const rateTransport = createGoogleTextSearchTransport({
      apiKey: 'provider-key-canary',
      fetcher: rateFetcher,
      observer: completeFailureObserver,
    });

    let rejected: unknown;
    await rateTransport.search(searchRequest).catch((error: unknown) => {
      rejected = error;
    });
    expect(rejected).toMatchObject({ code: 'RATE_LIMITED' });
    expect(rateFetcher).toHaveBeenCalledTimes(1);
  });

  it('does not treat an undefined upstream rejection as a successful call', async () => {
    const traces: RuntimeProviderTrace[] = [];
    const observer = createRuntimeProviderTransportObserver(
      baseTraceOptions((trace) => {
        traces.push(trace);
      }),
    );
    const transport = createGoogleTextSearchTransport({
      apiKey: 'provider-key-canary',
      // Exercise a provider that violates the Promise rejection contract at runtime.
      fetcher: () => {
        const rejectWithoutReason = Promise.reject.bind(Promise);
        return rejectWithoutReason();
      },
      observer,
    });

    await expect(transport.search(searchRequest)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status: 'error', resultCode: 'PROVIDER_UNAVAILABLE' });
  });

  it('assigns distinct call identities to retries while replay without a call creates no trace', async () => {
    const traces: RuntimeProviderTrace[] = [];
    const observer = createRuntimeProviderTransportObserver(
      baseTraceOptions((trace) => {
        traces.push(trace);
      }),
    );
    const search = createGoogleTextSearchTransport({
      apiKey: 'provider-key-canary',
      fetcher: () => Promise.resolve(jsonResponse({ places: [] })),
      observer,
    });

    await search.search(searchRequest);
    await search.search(searchRequest);
    expect(traces).toHaveLength(2);
    expect(new Set(traces.map((trace) => trace.callId)).size).toBe(2);
    const records = await Promise.all(traces.map((trace) => traceRecordForRuntimeProvider(trace)));
    expect(records.every((record) => record?.operation === 'provider')).toBe(true);
    expect(new Set(records.map((record) => record?.traceId)).size).toBe(2);
  });

  it('classifies photo expiry and bounded media failures without exposing provider details', () => {
    const traces: RuntimeProviderTrace[] = [];
    const observer = createRuntimeProviderTransportObserver(
      baseTraceOptions((trace) => {
        traces.push(trace);
      }),
    );
    const expired = observer.begin({ provider: 'photo' });
    expired.complete({ status: 'error', error: new PhotoProviderError('EXPIRED') });
    const oversized = observer.begin({ provider: 'photo' });
    oversized.complete({
      status: 'error',
      error: new PhotoProviderError('RESULT_TOO_LARGE'),
    });

    expect(traces).toMatchObject([
      { provider: 'photo', status: 'error', resultCode: 'EXPIRED' },
      { provider: 'photo', status: 'error', resultCode: 'PROVIDER_UNAVAILABLE' },
    ]);
  });

  it('keeps telemetry writes best effort and schedules the full validated record pipeline', async () => {
    const writes: { readonly record: unknown; readonly ownerScopeRef: string }[] = [];
    const scheduled: Promise<void>[] = [];
    const sink = createBestEffortRuntimeProviderTraceSink(
      {
        write: (record, ownerScopeRef) => {
          writes.push({ record, ownerScopeRef });
          return Promise.resolve();
        },
      },
      (promise) => scheduled.push(promise),
    );
    const observer = createRuntimeProviderTransportObserver({
      ...baseTraceOptions(() => undefined),
      sink,
    });
    const transport = createGoogleRouteMatrixTransport({
      apiKey: 'provider-key-canary',
      fetcher: () => Promise.resolve(jsonResponse([])),
      observer,
    });
    const result = await transport.compute(routeRequest);

    expect(result).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ownerScopeRef: 'owner-provider-trace' });
    expect(writes[0]?.record).toMatchObject({
      operation: 'provider',
      provider: 'routes',
      apiElementCount: 6,
    });
  });
});
