import { describe, expect, it, vi } from 'vitest';
import { createHotPepperTransport } from '../../../src/providers/hot-pepper/transport';
import type { HotPepperSearchRequest } from '../../../src/providers/hot-pepper/types';
import { PhotoProviderError } from '../../../src/providers/photo/media';
import { HotPepperError } from '../../../src/providers/hot-pepper/types';
import {
  createBestEffortRuntimeProviderTraceSink,
  createRuntimeProviderTransportObserver,
  traceRecordForRuntimeProvider,
  type RuntimeProviderTrace,
  type RuntimeProviderTraceOptions,
} from '../../../src/providers/telemetry/runtime-provider-trace';
import type { RuntimeProviderTransportObserver } from '../../../src/providers/telemetry/runtime-provider-trace-contract';

const searchRequest: HotPepperSearchRequest = {
  keyword: 'PROVIDER_REQUEST_CANARY quiet cafe',
  count: 2,
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

describe('runtime provider transport trace', () => {
  it('classifies typed timeout, cancellation, and rate-limit failures without changing errors', async () => {
    vi.useFakeTimers();
    try {
      const traces: RuntimeProviderTrace[] = [];
      const options = baseTraceOptions((trace) => {
        traces.push(trace);
      });
      const observer = createRuntimeProviderTransportObserver(options);
      const timeoutTransport = createHotPepperTransport({
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
      const fetcher = vi.fn(() => Promise.resolve(jsonResponse({ results: { shop: [] } })));
      const cancelledTransport = createHotPepperTransport({
        apiKey: 'provider-key-canary',
        fetcher,
        observer,
      });
      await expect(
        cancelledTransport.search(searchRequest, controller.signal),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(traces).toHaveLength(1);

      const rateLimitedTransport = createHotPepperTransport({
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
    const successFetcher = vi.fn(() => Promise.resolve(jsonResponse({ results: { shop: [] } })));
    const successTransport = createHotPepperTransport({
      apiKey: 'provider-key-canary',
      fetcher: successFetcher,
      observer: beginFailureObserver,
    });

    await expect(successTransport.search(searchRequest)).resolves.toEqual({
      shops: [],
      resultsAvailable: null,
      resultsStart: null,
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
    const rateTransport = createHotPepperTransport({
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
    const transport = createHotPepperTransport({
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
    const search = createHotPepperTransport({
      apiKey: 'provider-key-canary',
      fetcher: () => Promise.resolve(jsonResponse({ results: { shop: [] } })),
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

  it('classifies typed Hot Pepper transport failures without retaining provider details', () => {
    const traces: RuntimeProviderTrace[] = [];
    const observer = createRuntimeProviderTransportObserver(
      baseTraceOptions((trace) => {
        traces.push(trace);
      }),
    );
    const cases = [
      { error: new HotPepperError('TIMEOUT'), resultCode: 'PROVIDER_TIMEOUT' },
      { error: new HotPepperError('CANCELLED'), resultCode: 'CANCELLED' },
      { error: new HotPepperError('RATE_LIMITED'), resultCode: 'RATE_LIMITED' },
      { error: new HotPepperError('NOT_FOUND'), resultCode: 'NOT_FOUND' },
      { error: new HotPepperError('SOURCE_CONFLICT'), resultCode: 'CONFLICT' },
    ] as const;
    for (const { error } of cases) {
      observer.begin({ provider: 'hotpepper' }).complete({ status: 'error', error });
    }

    expect(traces).toHaveLength(cases.length);
    expect(traces.map((trace) => trace.resultCode)).toEqual(
      cases.map(({ resultCode }) => resultCode),
    );
    expect(traces.every((trace) => trace.provider === 'hotpepper')).toBe(true);
    expect(JSON.stringify(traces)).not.toContain('Hot Pepper provider failed');
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
    const transport = createHotPepperTransport({
      apiKey: 'provider-key-canary',
      fetcher: () => Promise.resolve(jsonResponse({ results: { shop: [] } })),
      observer,
    });
    const result = await transport.search(searchRequest);

    expect(result.shops).toEqual([]);
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ownerScopeRef: 'owner-provider-trace' });
    expect(writes[0]?.record).toMatchObject({
      operation: 'provider',
      provider: 'hotpepper',
    });
  });
});
