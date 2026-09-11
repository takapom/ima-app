import * as v from 'valibot';
import {
  HOT_PEPPER_GOURMET_ENDPOINT,
  HotPepperError,
  HotPepperSearchRequestSchema,
  type HotPepperSearchRequest,
} from './types';
import { parseHotPepperResponse, type HotPepperSearchPage } from './wire';

export type HotPepperTransportOptions = {
  /** The composition owner reads this from the Worker secret binding. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
};

export interface HotPepperTransport {
  search(request: HotPepperSearchRequest, signal?: AbortSignal): Promise<HotPepperSearchPage>;
}

export const HOT_PEPPER_MAX_RESPONSE_BYTES = 256_000;

const isFiniteTimeout = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= 60_000;

const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const fetchWithDeadline = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbort = (): void => undefined;
  const operationPromise = Promise.resolve().then(() => {
    if (externalSignal?.aborted === true) throw new HotPepperError('CANCELLED');
    if (controller.signal.aborted) throw new HotPepperError('TIMEOUT');
    return operation(controller.signal);
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new HotPepperError('TIMEOUT'));
    }, timeoutMs);
  });
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      cancelled = true;
      controller.abort();
      reject(new HotPepperError('CANCELLED'));
    };
    removeExternalAbort = (): void => externalSignal?.removeEventListener('abort', onAbort);
    if (externalSignal?.aborted === true) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise, cancellationPromise]);
  } catch (error: unknown) {
    if (error instanceof HotPepperError) throw error;
    if (timedOut) throw new HotPepperError('TIMEOUT');
    if (cancelled || externalSignal?.aborted === true) throw new HotPepperError('CANCELLED');
    throw new HotPepperError('UPSTREAM_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort();
  }
};

const discardResponseBody = async (response: Response): Promise<void> => {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // A status error remains the authoritative provider failure.
  }
};

const readBoundedText = async (response: Response): Promise<string> => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/u.test(contentLength.trim())) {
    const declaredLength = Number(contentLength.trim());
    if (!Number.isSafeInteger(declaredLength) || declaredLength > HOT_PEPPER_MAX_RESPONSE_BYTES) {
      await discardResponseBody(response);
      throw new HotPepperError('SCHEMA_MISMATCH');
    }
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > HOT_PEPPER_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HotPepperError('SCHEMA_MISMATCH');
      }
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await readBoundedText(response);
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new HotPepperError('SCHEMA_MISMATCH');
  }
};

const requestUrlFor = (request: HotPepperSearchRequest, apiKey: string): string => {
  const url = new URL(HOT_PEPPER_GOURMET_ENDPOINT);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('keyword', request.keyword);
  url.searchParams.set('lat', String(request.lat));
  url.searchParams.set('lng', String(request.lng));
  url.searchParams.set('range', String(request.range ?? 1));
  url.searchParams.set('count', String(request.count ?? 10));
  return url.toString();
};

const searchWith = async (
  options: Required<Pick<HotPepperTransportOptions, 'timeoutMs'>> & HotPepperTransportOptions,
  request: HotPepperSearchRequest,
  signal: AbortSignal | undefined,
): Promise<HotPepperSearchPage> => {
  const parsedRequest = v.safeParse(HotPepperSearchRequestSchema, request);
  if (!parsedRequest.success) throw new HotPepperError('INVALID_REQUEST');
  if (signal?.aborted === true) throw new HotPepperError('CANCELLED');
  const apiKey = options.apiKey?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new HotPepperError('MISSING_API_KEY');
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  const url = requestUrlFor(parsedRequest.output, apiKey);
  const upstream = await fetchWithDeadline(
    async (requestSignal) => {
      const response = await fetcher(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: requestSignal,
      });
      if (!response.ok) {
        await discardResponseBody(response);
        return { response, body: null };
      }
      return { response, body: await readJson(response) };
    },
    signal,
    options.timeoutMs,
  );

  if (!upstream.response.ok) {
    if (upstream.response.status === 404) {
      throw new HotPepperError('NOT_FOUND', { status: 404 });
    }
    if (upstream.response.status === 429) {
      throw new HotPepperError('RATE_LIMITED', {
        status: 429,
        retryAfterMs: parseRetryAfter(upstream.response.headers.get('retry-after')),
      });
    }
    if (upstream.response.status >= 500) {
      throw new HotPepperError('UPSTREAM_UNAVAILABLE', { status: upstream.response.status });
    }
    throw new HotPepperError('INVALID_REQUEST', { status: upstream.response.status });
  }
  if (upstream.body === null) throw new HotPepperError('SCHEMA_MISMATCH');
  return parseHotPepperResponse(upstream.body);
};

export const createHotPepperTransport = (
  inputOptions: HotPepperTransportOptions,
): HotPepperTransport => {
  const options = { ...inputOptions, timeoutMs: inputOptions.timeoutMs ?? 800 };
  if (!isFiniteTimeout(options.timeoutMs)) throw new HotPepperError('INVALID_REQUEST');
  return { search: (request, signal) => searchWith(options, request, signal) };
};
