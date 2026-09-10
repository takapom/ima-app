import * as v from 'valibot';
import {
  DEFAULT_PHOTO_MAX_BYTES,
  DEFAULT_PHOTO_MAX_WIDTH_PX,
  DEFAULT_PHOTO_METADATA_MAX_BYTES,
  DEFAULT_PHOTO_TIMEOUT_MS,
  GOOGLE_PHOTO_MEDIA_ORIGIN,
  GOOGLE_PHOTO_REDIRECT_HOSTS,
  PhotoContentTypeSchema,
  PhotoProviderError,
  type PhotoContentType,
  type PhotoMedia,
  type PhotoMediaTransport,
} from './media';
import { PhotoResourceNameSchema } from './types';

const isTimeout = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= 60_000;

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const parseContentLength = (value: string | null): number | null => {
  if (value === null || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const parseContentType = (value: string | null): PhotoContentType => {
  const parsed = v.safeParse(PhotoContentTypeSchema, value?.split(';', 1)[0]?.trim() ?? '');
  if (!parsed.success) throw new PhotoProviderError('UNSUPPORTED_MEDIA_TYPE');
  return parsed.output;
};

const retryAfterMs = (value: string | null): number | null => {
  if (value === null || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return null;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const providerErrorForStatus = (response: Response): PhotoProviderError => {
  if (response.status === 400 || response.status === 404) return new PhotoProviderError('EXPIRED');
  if (response.status === 429) {
    return new PhotoProviderError(
      'RATE_LIMITED',
      retryAfterMs(response.headers.get('retry-after')),
    );
  }
  return new PhotoProviderError('UPSTREAM_UNAVAILABLE');
};

type RequestDeadline = {
  readonly controller: AbortController;
  readonly failure: () => PhotoProviderError | null;
  readonly clear: () => void;
};

type ManagedResponse = RequestDeadline & { readonly response: Response };

const fetchWithDeadline = async (
  fetcher: typeof fetch,
  url: string,
  headers: HeadersInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ManagedResponse> => {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = signal?.aborted === true;
  let cleared = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => {
    cancelled = true;
    controller.abort();
  };
  const clear = (): void => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  const failure = (): PhotoProviderError | null => {
    if (timedOut) return new PhotoProviderError('TIMEOUT');
    if (cancelled || signal?.aborted === true) return new PhotoProviderError('CANCELLED');
    return null;
  };
  if (cancelled) {
    clear();
    throw new PhotoProviderError('CANCELLED');
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers,
      signal: controller.signal,
    });
    return { response, controller, failure, clear };
  } catch (error: unknown) {
    clear();
    throw (
      failure() ??
      (error instanceof PhotoProviderError ? error : new PhotoProviderError('UPSTREAM_UNAVAILABLE'))
    );
  }
};

const cancelResponse = async (managed: ManagedResponse): Promise<void> => {
  try {
    await managed.response.body?.cancel();
  } catch {
    throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
  } finally {
    managed.clear();
  }
};

const readLimitedBody = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  managed: RequestDeadline,
): Promise<Uint8Array> => {
  if (body === null) throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelPromise: Promise<void> | undefined;
  let cancelError: unknown;
  const cancelReader = (): Promise<void> => {
    cancelPromise ??= reader.cancel().catch((error: unknown) => {
      cancelError = error;
    });
    return cancelPromise;
  };
  const cancelOnAbort = (): void => {
    void cancelReader().catch((error: unknown) => {
      cancelError = error;
    });
  };
  managed.controller.signal.addEventListener('abort', cancelOnAbort, { once: true });
  if (managed.controller.signal.aborted) cancelOnAbort();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        const aborted = managed.failure();
        if (aborted !== null) throw aborted;
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return output;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        await cancelReader();
        managed.controller.abort();
        throw new PhotoProviderError('RESULT_TOO_LARGE');
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    const aborted = managed.failure();
    if (cancelError !== undefined && aborted === null) {
      throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
    }
    throw (
      aborted ??
      (error instanceof PhotoProviderError ? error : new PhotoProviderError('UPSTREAM_UNAVAILABLE'))
    );
  } finally {
    managed.controller.signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
};

const parsePhotoUri = (value: unknown): string => {
  if (typeof value !== 'object' || value === null || !('photoUri' in value)) {
    throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
  }
  const photoUri = value.photoUri;
  if (typeof photoUri !== 'string') throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
  let parsed: URL;
  try {
    parsed = new URL(photoUri);
  } catch {
    throw new PhotoProviderError('REDIRECT_REJECTED');
  }
  const allowedHost = GOOGLE_PHOTO_REDIRECT_HOSTS.some((host) => host === parsed.hostname);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    !allowedHost
  ) {
    throw new PhotoProviderError('REDIRECT_REJECTED');
  }
  return parsed.toString();
};

const readPhotoUri = async (managed: ManagedResponse, maxBytes: number): Promise<string> => {
  try {
    const bytes = await readLimitedBody(managed.response.body, maxBytes, managed);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
    }
    return parsePhotoUri(value);
  } finally {
    managed.clear();
  }
};

const streamWithLimit = (
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  managed: RequestDeadline,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let total = 0;
  let settled = false;
  let cancelPromise: Promise<void> | undefined;
  let cancelError: unknown;
  const streamControllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};
  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch((error: unknown) => {
      cancelError = error;
    });
    return cancelPromise;
  };
  const abortStream = (): void => {
    void cancelReader().catch((error: unknown) => {
      cancelError = error;
    });
    if (settled) return;
    streamControllerRef.current?.error(managed.failure() ?? new PhotoProviderError('CANCELLED'));
    finish();
  };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    managed.controller.signal.removeEventListener('abort', abortStream);
    managed.clear();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamControllerRef.current = streamController;
      managed.controller.signal.addEventListener('abort', abortStream, { once: true });
      if (managed.controller.signal.aborted) abortStream();
    },
    async pull(streamController) {
      if (settled) return;
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          streamController.close();
          return;
        }
        if (!(result.value instanceof Uint8Array)) {
          await cancelReader();
          finish();
          streamController.error(new PhotoProviderError('UPSTREAM_UNAVAILABLE'));
          return;
        }
        total += result.value.byteLength;
        if (total > maxBytes) {
          await cancelReader();
          finish();
          streamController.error(new PhotoProviderError('RESULT_TOO_LARGE'));
          return;
        }
        streamController.enqueue(result.value);
      } catch (error: unknown) {
        if (settled) return;
        const aborted = managed.failure();
        finish();
        streamController.error(
          aborted ??
            (cancelError !== undefined
              ? new PhotoProviderError('UPSTREAM_UNAVAILABLE')
              : undefined) ??
            (error instanceof PhotoProviderError
              ? error
              : new PhotoProviderError('UPSTREAM_UNAVAILABLE')),
        );
      }
    },
    async cancel(reason) {
      try {
        await cancelReader(reason);
        if (cancelError !== undefined) throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
      } finally {
        managed.controller.abort();
        finish();
      }
    },
  });
  return stream;
};

export type GooglePhotoMediaTransportOptions = {
  readonly apiKey?: string;
  readonly maxBytes?: number;
  readonly maxWidthPx?: number;
  readonly timeoutMs?: number;
  readonly metadataMaxBytes?: number;
  readonly fetcher?: typeof fetch;
};

export const createGooglePhotoMediaTransport = (
  inputOptions: GooglePhotoMediaTransportOptions,
): PhotoMediaTransport => {
  const options = {
    ...inputOptions,
    maxBytes: inputOptions.maxBytes ?? DEFAULT_PHOTO_MAX_BYTES,
    maxWidthPx: inputOptions.maxWidthPx ?? DEFAULT_PHOTO_MAX_WIDTH_PX,
    timeoutMs: inputOptions.timeoutMs ?? DEFAULT_PHOTO_TIMEOUT_MS,
    metadataMaxBytes: inputOptions.metadataMaxBytes ?? DEFAULT_PHOTO_METADATA_MAX_BYTES,
  };
  if (
    !isTimeout(options.timeoutMs) ||
    !isPositiveInteger(options.maxBytes) ||
    !isPositiveInteger(options.metadataMaxBytes)
  ) {
    throw new PhotoProviderError('INVALID_REQUEST');
  }
  if (
    !Number.isSafeInteger(options.maxWidthPx) ||
    options.maxWidthPx < 1 ||
    options.maxWidthPx > 4_800
  ) {
    throw new PhotoProviderError('INVALID_REQUEST');
  }
  return {
    async read(photoRef, signal): Promise<PhotoMedia> {
      if (!v.safeParse(PhotoResourceNameSchema, photoRef).success) {
        throw new PhotoProviderError('INVALID_REQUEST');
      }
      if (signal?.aborted === true) throw new PhotoProviderError('CANCELLED');
      const apiKey = options.apiKey?.trim();
      if (apiKey === undefined || apiKey.length === 0) {
        throw new PhotoProviderError('MISSING_API_KEY');
      }
      const mediaUrl = new URL(`${GOOGLE_PHOTO_MEDIA_ORIGIN}/v1/${photoRef}/media`);
      mediaUrl.searchParams.set('maxWidthPx', String(options.maxWidthPx));
      mediaUrl.searchParams.set('skipHttpRedirect', 'true');
      const fetcher = options.fetcher ?? globalThis.fetch;
      const deadlineAt = Date.now() + options.timeoutMs;
      const remainingTimeout = (): number => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new PhotoProviderError('TIMEOUT');
        return Math.min(options.timeoutMs, remaining);
      };
      const metadata = await fetchWithDeadline(
        fetcher,
        mediaUrl.toString(),
        { accept: 'application/json', 'x-goog-api-key': apiKey },
        signal,
        remainingTimeout(),
      );
      let photoUri: string;
      try {
        if (!metadata.response.ok) {
          const failure = providerErrorForStatus(metadata.response);
          await cancelResponse(metadata);
          throw failure;
        }
        photoUri = await readPhotoUri(metadata, options.metadataMaxBytes);
      } finally {
        metadata.clear();
      }
      const image = await fetchWithDeadline(
        fetcher,
        photoUri,
        { accept: 'image/*' },
        signal,
        remainingTimeout(),
      );
      if (!image.response.ok || image.response.body === null) {
        const failure = image.response.ok
          ? new PhotoProviderError('UPSTREAM_UNAVAILABLE')
          : providerErrorForStatus(image.response);
        await cancelResponse(image);
        throw failure;
      }
      const contentLength = parseContentLength(image.response.headers.get('content-length'));
      if (contentLength !== null && contentLength > options.maxBytes) {
        await cancelResponse(image);
        throw new PhotoProviderError('RESULT_TOO_LARGE');
      }
      let contentType: PhotoContentType;
      try {
        contentType = parseContentType(image.response.headers.get('content-type'));
      } catch (error: unknown) {
        await cancelResponse(image);
        throw error;
      }
      return {
        body: streamWithLimit(image.response.body, options.maxBytes, image),
        contentType,
        contentLength,
      };
    },
  };
};
