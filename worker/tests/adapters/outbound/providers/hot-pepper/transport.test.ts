import { describe, expect, it, vi } from 'vitest';
import {
  HOT_PEPPER_GOURMET_ENDPOINT,
  HotPepperError,
  type HotPepperSearchRequest,
} from '@worker/adapters/outbound/providers/hot-pepper/types';
import {
  HOT_PEPPER_MAX_RESPONSE_BYTES,
  createHotPepperTransport,
  type HotPepperTransportOptions,
} from '@worker/adapters/outbound/providers/hot-pepper/transport';
import type {
  RuntimeProviderTransportCompletion,
  RuntimeProviderTransportObserver,
} from '@worker/runtime/tracing/runtime-provider-trace-contract';

const request: HotPepperSearchRequest = {
  keyword: '静かなカフェ 恵比寿',
  lat: 35.6467,
  lng: 139.71,
  range: 1,
  count: 2,
};

const response = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), headers === undefined ? { status } : { status, headers });

const bodyFor = (id = 'hp-1') => ({
  results: {
    results_available: 1,
    results_returned: 1,
    results_start: 1,
    shop: [
      {
        id,
        name: 'カフェ恵比寿',
        lat: 35.6468,
        lng: 139.71,
        urls: { pc: 'https://www.hotpepper.jp/strJ000000001' },
      },
    ],
  },
});

const makeTransport = (
  fetcher: NonNullable<HotPepperTransportOptions['fetcher']>,
  overrides: Omit<HotPepperTransportOptions, 'fetcher'> = {},
) => createHotPepperTransport({ apiKey: 'key-never-logged', fetcher, ...overrides });

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

describe('Hot Pepper transport', () => {
  it('uses the official JSON endpoint and sends only bounded query parameters', async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
    const fetcher = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: requestUrl(input), init });
      return Promise.resolve(response(bodyFor()));
    };
    await expect(makeTransport(fetcher).search(request)).resolves.toMatchObject({
      resultsAvailable: 1,
      shops: [{ id: 'hp-1' }],
    });
    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('fixture request was not sent');
    const url = new URL(call.url);
    expect(url.origin + url.pathname + '?').toBe(`${HOT_PEPPER_GOURMET_ENDPOINT}?`);
    expect(url.searchParams.get('key')).toBe('key-never-logged');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('keyword')).toBe(request.keyword);
    expect(url.searchParams.get('lat')).toBe(String(request.lat));
    expect(url.searchParams.get('lng')).toBe(String(request.lng));
    expect(url.searchParams.get('range')).toBe('1');
    expect(url.searchParams.get('count')).toBe('2');
    expect(call.init?.method).toBe('GET');
    expect(call.init?.body).toBeUndefined();
    expect(call.init?.redirect).toBe('manual');
    expect(call.init?.headers).toEqual({ accept: 'application/json' });
  });

  it('rejects missing keys and malformed requests before starting HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response(bodyFor())));
    let beginCount = 0;
    const observer: RuntimeProviderTransportObserver = {
      begin: () => {
        beginCount += 1;
        return { complete: () => undefined };
      },
    };
    await expect(
      createHotPepperTransport({ apiKey: '', fetcher, observer }).search(request),
    ).rejects.toMatchObject({
      code: 'MISSING_API_KEY',
    });
    await expect(
      createHotPepperTransport({ apiKey: 'key', fetcher, observer }).search({
        ...request,
        count: 21,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      createHotPepperTransport({ apiKey: 'key', fetcher, observer }).search(
        request,
        cancelled.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(beginCount).toBe(0);
  });

  it('observes one complete fetch and classifies a non-success status', async () => {
    const began: Parameters<RuntimeProviderTransportObserver['begin']>[0][] = [];
    const completed: RuntimeProviderTransportCompletion[] = [];
    const observer: RuntimeProviderTransportObserver = {
      begin: (input) => {
        began.push(input);
        return { complete: (completion) => completed.push(completion) };
      },
    };
    await expect(
      makeTransport(() => Promise.resolve(response(bodyFor())), { observer }).search(request),
    ).resolves.toMatchObject({ resultsAvailable: 1 });
    await expect(
      makeTransport(() => Promise.resolve(response({ error: 'provider-body-canary' }, 429)), {
        observer,
      }).search(request),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    expect(began).toEqual([{ provider: 'hotpepper' }, { provider: 'hotpepper' }]);
    expect(completed).toHaveLength(2);
    expect(completed[0]).toEqual({ status: 'ok' });
    expect(completed[1]).toMatchObject({ status: 'error', error: { code: 'RATE_LIMITED' } });
    expect(JSON.stringify(completed)).not.toContain('provider-body-canary');
  });

  it('classifies a timeout while the provider fetch is pending', async () => {
    vi.useFakeTimers();
    try {
      const completed: RuntimeProviderTransportCompletion[] = [];
      const observer: RuntimeProviderTransportObserver = {
        begin: () => ({ complete: (completion) => completed.push(completion) }),
      };
      const transport = makeTransport(() => new Promise<Response>(() => undefined), {
        observer,
        timeoutMs: 10,
      });
      const pending = transport.search(request);
      const expectation = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await expectation;
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ status: 'error', error: { code: 'TIMEOUT' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies cancellation while reading the provider body', async () => {
    const cancelled = new AbortController();
    const completed: RuntimeProviderTransportCompletion[] = [];
    const observer: RuntimeProviderTransportObserver = {
      begin: () => ({ complete: (completion) => completed.push(completion) }),
    };
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let chunkDelivered!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      chunkDelivered = resolve;
    });
    let readerRequestedNextChunk!: () => void;
    const nextChunkRequested = new Promise<void>((resolve) => {
      readerRequestedNextChunk = resolve;
    });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
      pull: (controller) => {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"results":'));
          chunkDelivered();
          return;
        }
        readerRequestedNextChunk();
      },
    });
    let fetchCount = 0;
    const fetcher: NonNullable<HotPepperTransportOptions['fetcher']> = (_input, init) => {
      fetchCount += 1;
      init?.signal?.addEventListener(
        'abort',
        () => streamController?.error(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
      return Promise.resolve(new Response(body));
    };
    const transport = makeTransport(fetcher, { observer, timeoutMs: 1_000 });
    const pending = transport.search(request, cancelled.signal);
    await firstChunk;
    await nextChunkRequested;
    cancelled.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchCount).toBe(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: 'error', error: { code: 'CANCELLED' } });
  });

  it('maps HTTP and body-level errors without exposing provider text or keys', async () => {
    const rateLimited = makeTransport(() =>
      Promise.resolve(response({ error: 'private key text' }, 429, { 'retry-after': '1.2' })),
    );
    await expect(rateLimited.search(request)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterMs: 1_200,
    });

    const redirected = makeTransport(() =>
      Promise.resolve(response({ location: 'https://attacker.invalid' }, 302)),
    );
    await expect(redirected.search(request)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 302,
    });

    const apiError = makeTransport(() =>
      Promise.resolve(response({ results: { error: { code: 2000, message: 'secret response' } } })),
    );
    await expect(apiError.search(request)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    try {
      await apiError.search(request);
    } catch (error: unknown) {
      expect(String(error)).not.toContain('secret response');
      expect(String(error)).not.toContain('key-never-logged');
    }

    await expect(
      makeTransport(() => Promise.resolve(response({}, 503))).search(request),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      status: 503,
    });
    await expect(
      makeTransport(() => Promise.resolve(new Response('<xml/>'))).search(request),
    ).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('discards non-success response bodies before returning a typed status error', async () => {
    const cancel = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const body = new ReadableStream<Uint8Array>({ cancel });
    const transport = makeTransport(() => Promise.resolve(new Response(body, { status: 503 })));
    await expect(transport.search(request)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('distinguishes cancellation, timeout, and an undefined upstream rejection', async () => {
    vi.useFakeTimers();
    try {
      let started = false;
      const transport = makeTransport(
        (_input, init) => {
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
      const cancelled = transport.search(request, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(started).toBe(false);

      const timedOut = transport.search(request);
      const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(10);
      await timedOutExpectation;

      await expect(
        // Provider promises can reject without a reason; transport must still classify this safely.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        makeTransport(() => new Promise<Response>((_resolve, reject) => reject())).search(request),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps provider errors typed even when the response body is malformed', async () => {
    const transport = makeTransport(() => Promise.resolve(response({ results: { shop: 'bad' } })));
    await expect(transport.search(request)).rejects.toBeInstanceOf(HotPepperError);
  });

  it('bounds the response body before parsing provider fields', async () => {
    const transport = makeTransport(() =>
      Promise.resolve(new Response(`{"results":{"shop":[{"id":"${'x'.repeat(260_000)}"}]}}`)),
    );
    await expect(transport.search(request)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
  });

  it('cancels a body rejected by its declared size before parsing', async () => {
    const cancel = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const body = new ReadableStream<Uint8Array>({ cancel });
    const transport = makeTransport(() =>
      Promise.resolve(
        new Response(body, {
          headers: { 'content-length': String(HOT_PEPPER_MAX_RESPONSE_BYTES + 1) },
        }),
      ),
    );
    await expect(transport.search(request)).rejects.toMatchObject({ code: 'SCHEMA_MISMATCH' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
