import * as v from 'valibot';
import {
  GOOGLE_ROUTE_MATRIX_ENDPOINT,
  GOOGLE_ROUTE_MATRIX_FIELD_MASK,
  GOOGLE_ROUTE_MATRIX_MAX_ELEMENTS,
  GoogleRouteMatrixError,
  GoogleRouteMatrixRequestSchema,
  type GoogleRouteMatrixElement,
  type GoogleRouteMatrixRequest,
  type GoogleRouteMatrixResponse,
  type GoogleRouteMatrixTransport,
  type GoogleRouteMatrixTransportOptions,
} from './types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isRouteCondition = (value: unknown): value is GoogleRouteMatrixElement['condition'] =>
  value === 'ROUTE_EXISTS' ||
  value === 'ROUTE_NOT_FOUND' ||
  value === 'ROUTE_MATRIX_ELEMENT_CONDITION_UNSPECIFIED';

const isDuration = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d{1,9})?s$/.test(value);

const parseElement = (value: unknown): GoogleRouteMatrixElement => {
  if (!isRecord(value)) throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
  const originIndex =
    value.originIndex === undefined || value.originIndex === null ? 0 : value.originIndex;
  const destinationIndex =
    value.destinationIndex === undefined || value.destinationIndex === null
      ? 0
      : value.destinationIndex;
  if (!isSafeNonNegativeInteger(originIndex)) {
    throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
  }
  if (!isSafeNonNegativeInteger(destinationIndex)) {
    throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
  }

  let parseError = false;
  let status: GoogleRouteMatrixElement['status'];
  if (value.status !== undefined && value.status !== null) {
    if (!isRecord(value.status)) {
      parseError = true;
    } else {
      const code = value.status.code;
      if (code !== undefined && code !== null && !isSafeNonNegativeInteger(code)) {
        parseError = true;
      } else {
        status = code === undefined || code === null ? {} : { code };
      }
    }
  }

  let condition: GoogleRouteMatrixElement['condition'];
  if (value.condition !== undefined && value.condition !== null) {
    if (!isRouteCondition(value.condition)) parseError = true;
    else condition = value.condition;
  }

  let distanceMeters: number | undefined;
  if (value.distanceMeters !== undefined && value.distanceMeters !== null) {
    if (!isSafeNonNegativeInteger(value.distanceMeters)) parseError = true;
    else distanceMeters = value.distanceMeters;
  }

  let duration: string | undefined;
  if (value.duration !== undefined && value.duration !== null) {
    if (!isDuration(value.duration)) parseError = true;
    else duration = value.duration;
  }

  return {
    originIndex,
    destinationIndex,
    ...(status === undefined ? {} : { status }),
    ...(condition === undefined ? {} : { condition }),
    ...(distanceMeters === undefined ? {} : { distanceMeters }),
    ...(duration === undefined ? {} : { duration }),
    ...(parseError ? { parseError: 'INVALID_ELEMENT' as const } : {}),
  };
};

/** Validates the REST array while discarding unrequested provider fields. */
export const parseGoogleRouteMatrixResponse = (value: unknown): GoogleRouteMatrixResponse => {
  if (!Array.isArray(value) || value.length > GOOGLE_ROUTE_MATRIX_MAX_ELEMENTS) {
    throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
  }
  return value.map(parseElement);
};

const pointBody = (point: GoogleRouteMatrixRequest['origins'][number]) => ({
  waypoint: {
    location: {
      latLng: {
        latitude: point.coordinates.lat,
        longitude: point.coordinates.lng,
      },
    },
  },
});

type GoogleRouteMatrixBody = {
  readonly origins: readonly ReturnType<typeof pointBody>[];
  readonly destinations: readonly ReturnType<typeof pointBody>[];
  readonly travelMode: 'WALK';
  readonly departureTime?: string;
};

const requestBody = (request: GoogleRouteMatrixRequest): GoogleRouteMatrixBody => ({
  origins: request.origins.map(pointBody),
  destinations: request.destinations.map(pointBody),
  travelMode: 'WALK',
  ...(request.departureTime === undefined ? {} : { departureTime: request.departureTime }),
});

const isFiniteTimeout = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= 60_000;

const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const abortError = (code: 'TIMEOUT' | 'CANCELLED'): GoogleRouteMatrixError =>
  new GoogleRouteMatrixError(code);

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
    if (error instanceof GoogleRouteMatrixError) throw error;
    if (timedOut) throw abortError('TIMEOUT');
    if (cancelled || externalSignal?.aborted === true) throw abortError('CANCELLED');
    throw new GoogleRouteMatrixError('UPSTREAM_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort();
  }
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new GoogleRouteMatrixError('SCHEMA_MISMATCH');
  }
};

const computeWith = async (
  options: Required<Pick<GoogleRouteMatrixTransportOptions, 'timeoutMs'>> &
    GoogleRouteMatrixTransportOptions,
  request: GoogleRouteMatrixRequest,
  signal: AbortSignal | undefined,
): Promise<GoogleRouteMatrixResponse> => {
  if (!v.safeParse(GoogleRouteMatrixRequestSchema, request).success) {
    throw new GoogleRouteMatrixError('INVALID_REQUEST');
  }
  if (options.apiKey === undefined || options.apiKey.trim() === '') {
    throw new GoogleRouteMatrixError('MISSING_API_KEY');
  }
  if (signal?.aborted === true) throw new GoogleRouteMatrixError('CANCELLED');

  const fetcher = options.fetcher ?? globalThis.fetch;
  const apiKey = options.apiKey;
  const result = await fetchWithDeadline(
    async (requestSignal) => {
      const response = await fetcher(GOOGLE_ROUTE_MATRIX_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          'x-goog-fieldmask': GOOGLE_ROUTE_MATRIX_FIELD_MASK,
        },
        body: JSON.stringify(requestBody(request)),
        signal: requestSignal,
        redirect: 'error',
      });
      return {
        response,
        body: response.ok ? await readJson(response) : null,
      };
    },
    signal,
    options.timeoutMs,
  );

  const response = result.response;
  if (!response.ok) {
    if (response.status === 429) {
      throw new GoogleRouteMatrixError('RATE_LIMITED', {
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    if (response.status >= 500) {
      throw new GoogleRouteMatrixError('UPSTREAM_UNAVAILABLE', { status: response.status });
    }
    throw new GoogleRouteMatrixError('INVALID_REQUEST', { status: response.status });
  }

  return parseGoogleRouteMatrixResponse(result.body);
};

export const createGoogleRouteMatrixTransport = (
  inputOptions: GoogleRouteMatrixTransportOptions,
): GoogleRouteMatrixTransport => {
  const options = {
    ...inputOptions,
    timeoutMs: inputOptions.timeoutMs ?? 3_000,
  };
  if (!isFiniteTimeout(options.timeoutMs)) {
    throw new GoogleRouteMatrixError('INVALID_REQUEST');
  }

  return {
    compute: (request, signal) => computeWith(options, request, signal),
  };
};
