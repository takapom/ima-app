import * as v from 'valibot';
import {
  GOOGLE_PLACE_DETAILS_ENDPOINT,
  GooglePlaceDetailsError,
  GooglePlaceDetailsRequestSchema,
  googlePlaceDetailsFieldMask,
  type GooglePlaceDetailsResponse,
  type GooglePlaceDetailsTransport,
  type GooglePlaceDetailsTransportOptions,
  type GooglePlaceDetailsRequest,
} from './types';

const isFiniteTimeout = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= 60_000;

const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const readJsonObject = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) throw new Error('response is not a JSON object');
    return parsed;
  } catch {
    throw new GooglePlaceDetailsError('SCHEMA_MISMATCH');
  }
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
    if (externalSignal?.aborted === true) {
      throw new GooglePlaceDetailsError('CANCELLED');
    }
    if (controller.signal.aborted) throw new GooglePlaceDetailsError('TIMEOUT');
    return operation(controller.signal);
  });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new GooglePlaceDetailsError('TIMEOUT'));
    }, timeoutMs);
  });
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      cancelled = true;
      controller.abort();
      reject(new GooglePlaceDetailsError('CANCELLED'));
    };
    removeExternalAbort = (): void => externalSignal?.removeEventListener('abort', onAbort);
    if (externalSignal?.aborted === true) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise, cancellationPromise]);
  } catch (error: unknown) {
    if (error instanceof GooglePlaceDetailsError) throw error;
    if (timedOut) throw new GooglePlaceDetailsError('TIMEOUT');
    if (cancelled || externalSignal?.aborted === true) {
      throw new GooglePlaceDetailsError('CANCELLED');
    }
    throw new GooglePlaceDetailsError('UPSTREAM_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort();
  }
};

const readWith = async (
  options: Required<Pick<GooglePlaceDetailsTransportOptions, 'timeoutMs'>> &
    GooglePlaceDetailsTransportOptions,
  request: GooglePlaceDetailsRequest,
  signal: AbortSignal | undefined,
): Promise<GooglePlaceDetailsResponse> => {
  const parsedRequest = v.safeParse(GooglePlaceDetailsRequestSchema, request);
  if (!parsedRequest.success) {
    throw new GooglePlaceDetailsError('INVALID_REQUEST');
  }
  if (signal?.aborted === true) throw new GooglePlaceDetailsError('CANCELLED');
  const apiKey = options.apiKey;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new GooglePlaceDetailsError('MISSING_API_KEY');
  }

  const validRequest = parsedRequest.output;
  const fieldMask = googlePlaceDetailsFieldMask(validRequest.fields);
  if (fieldMask.length === 0) throw new GooglePlaceDetailsError('INVALID_REQUEST');
  const fetcher = options.fetcher ?? globalThis.fetch;
  const encodedPlaceId = encodeURIComponent(validRequest.placeId);
  const upstream = await fetchWithDeadline(
    async (requestSignal) => {
      const response = await fetcher(`${GOOGLE_PLACE_DETAILS_ENDPOINT}/${encodedPlaceId}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          'x-goog-fieldmask': fieldMask,
        },
        redirect: 'error',
        signal: requestSignal,
      });
      return {
        response,
        body: response.ok ? await readJsonObject(response) : null,
      };
    },
    signal,
    options.timeoutMs,
  );

  if (!upstream.response.ok) {
    if (upstream.response.status === 404) {
      throw new GooglePlaceDetailsError('NOT_FOUND', { status: 404 });
    }
    if (upstream.response.status === 429) {
      throw new GooglePlaceDetailsError('RATE_LIMITED', {
        status: 429,
        retryAfterMs: parseRetryAfter(upstream.response.headers.get('retry-after')),
      });
    }
    if (upstream.response.status >= 500) {
      throw new GooglePlaceDetailsError('UPSTREAM_UNAVAILABLE', {
        status: upstream.response.status,
      });
    }
    throw new GooglePlaceDetailsError('INVALID_REQUEST', {
      status: upstream.response.status,
    });
  }

  if (upstream.body === null) throw new GooglePlaceDetailsError('SCHEMA_MISMATCH');
  return { placeId: validRequest.placeId, fields: validRequest.fields, body: upstream.body };
};

export const createGooglePlaceDetailsTransport = (
  inputOptions: GooglePlaceDetailsTransportOptions,
): GooglePlaceDetailsTransport => {
  const options = {
    ...inputOptions,
    timeoutMs: inputOptions.timeoutMs ?? 10_000,
  };
  if (!isFiniteTimeout(options.timeoutMs)) {
    throw new GooglePlaceDetailsError('INVALID_REQUEST');
  }

  return {
    read: (request, signal) => readWith(options, request, signal),
  };
};
