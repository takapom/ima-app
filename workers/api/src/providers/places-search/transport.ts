import * as v from 'valibot';
import {
  GOOGLE_TEXT_SEARCH_ENDPOINT,
  GOOGLE_TEXT_SEARCH_FIELD_MASK,
  GoogleTextSearchError,
  type GoogleTextSearchPage,
  type GoogleTextSearchRequest,
} from './types';

const GoogleTextSearchResponseSchema = v.object({
  places: v.optional(v.pipe(v.array(v.unknown()), v.maxLength(20))),
  nextPageToken: v.optional(v.pipe(v.string(), v.maxLength(1_024))),
});

const GoogleTextSearchRequestSchema = v.strictObject({
  textQuery: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  openNow: v.boolean(),
  pageSize: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(20)),
  pageToken: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1_024))),
  locationBias: v.optional(
    v.strictObject({
      circle: v.strictObject({
        center: v.strictObject({
          latitude: v.pipe(v.number(), v.minValue(-90), v.maxValue(90)),
          longitude: v.pipe(v.number(), v.minValue(-180), v.maxValue(180)),
        }),
        radius: v.pipe(v.number(), v.minValue(0), v.maxValue(50_000)),
      }),
    }),
  ),
});

export type GoogleTextSearchTransportOptions = {
  /** The key is read from the Worker secret binding by the composition owner. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
};

export interface GoogleTextSearchTransport {
  search(request: GoogleTextSearchRequest, signal?: AbortSignal): Promise<GoogleTextSearchPage>;
}

const isFiniteTimeout = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= 60_000;

const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const abortError = (code: 'TIMEOUT' | 'CANCELLED'): GoogleTextSearchError =>
  new GoogleTextSearchError(code);

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
    if (externalSignal?.aborted === true) throw abortError('CANCELLED');
    if (controller.signal.aborted) throw abortError('TIMEOUT');
    return operation(controller.signal);
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(abortError('TIMEOUT'));
    }, timeoutMs);
  });
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      cancelled = true;
      controller.abort();
      reject(abortError('CANCELLED'));
    };
    removeExternalAbort = (): void => externalSignal?.removeEventListener('abort', onAbort);
    if (externalSignal?.aborted === true) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise, cancellationPromise]);
  } catch (error: unknown) {
    if (error instanceof GoogleTextSearchError) throw error;
    if (timedOut) throw abortError('TIMEOUT');
    if (cancelled || externalSignal?.aborted === true) throw abortError('CANCELLED');
    throw new GoogleTextSearchError('UPSTREAM_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort();
  }
};

const validateRequest = (request: GoogleTextSearchRequest): void => {
  if (!v.safeParse(GoogleTextSearchRequestSchema, request).success) {
    throw new GoogleTextSearchError('INVALID_REQUEST');
  }
};

const responsePage = (raw: unknown): GoogleTextSearchPage => {
  const parsed = v.safeParse(GoogleTextSearchResponseSchema, raw);
  if (!parsed.success) throw new GoogleTextSearchError('SCHEMA_MISMATCH');
  const nextPageToken = parsed.output.nextPageToken;
  return {
    places: parsed.output.places ?? [],
    nextPageToken: nextPageToken === undefined || nextPageToken.length === 0 ? null : nextPageToken,
  };
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GoogleTextSearchError('SCHEMA_MISMATCH');
  }
};

const searchWith = async (
  options: Required<Pick<GoogleTextSearchTransportOptions, 'timeoutMs'>> &
    GoogleTextSearchTransportOptions,
  request: GoogleTextSearchRequest,
  signal: AbortSignal | undefined,
): Promise<GoogleTextSearchPage> => {
  validateRequest(request);
  if (signal?.aborted === true) throw new GoogleTextSearchError('CANCELLED');
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new GoogleTextSearchError('MISSING_API_KEY');
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  const upstream = await fetchWithDeadline(
    async (requestSignal) => {
      const response = await fetcher(GOOGLE_TEXT_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          'x-goog-fieldmask': GOOGLE_TEXT_SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(request),
        redirect: 'error',
        signal: requestSignal,
      });
      return {
        response,
        body: response.ok ? await readJson(response) : null,
      };
    },
    signal,
    options.timeoutMs,
  );
  const response = upstream.response;

  if (!response.ok) {
    if (response.status === 429) {
      throw new GoogleTextSearchError('RATE_LIMITED', {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    if (response.status >= 500) {
      throw new GoogleTextSearchError('UPSTREAM_UNAVAILABLE', { status: response.status });
    }
    throw new GoogleTextSearchError('INVALID_REQUEST', { status: response.status });
  }

  if (upstream.body === null) throw new GoogleTextSearchError('SCHEMA_MISMATCH');
  return responsePage(upstream.body);
};

export const createGoogleTextSearchTransport = (
  inputOptions: GoogleTextSearchTransportOptions,
): GoogleTextSearchTransport => {
  const options = {
    ...inputOptions,
    timeoutMs: inputOptions.timeoutMs ?? 10_000,
  };
  if (!isFiniteTimeout(options.timeoutMs)) {
    throw new GoogleTextSearchError('INVALID_REQUEST');
  }

  return {
    search: (request, signal) => searchWith(options, request, signal),
  };
};
