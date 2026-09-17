import { REQUEST_ID_HEADER, parsePublicError, parsePhotoPath } from '@ima/contracts';
import { runWithinDeadline } from '@mobile/services/api/deadline';
import {
  buildApiUrl,
  credentialHeaders,
  parseRetryAfter,
  timeoutFor,
} from '@mobile/services/api/request-helpers';
import { issueResult, readJson } from '@mobile/services/api/response';
import type {
  ApiClientOptions,
  ApiError,
  ApiFetch,
  ApiRequestOptions,
  ApiSuccess,
} from '@mobile/services/api/api';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_ROUTE = 'photos';
const CLIENT_REQUEST_ID = 'client-invalid';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export type PhotoAsset = {
  /** A short-lived in-memory data URI; callers must not persist or cache it. */
  readonly uri: string;
  readonly contentType: string;
  readonly expiresAt: string;
};

export type PhotoFetchOptions = ApiRequestOptions & {
  /** The earliest public retention deadline for this photo, if known. */
  readonly displayUntil?: string | null;
};

export type PhotoApiError = ApiError | { readonly kind: 'expired' };
export type PhotoResult =
  | ApiSuccess<PhotoAsset>
  | {
      readonly ok: false;
      readonly error: PhotoApiError;
      readonly requestId: string;
    };

export type JourneyPhotoClient = {
  readonly fetchPhoto: (token: string, options?: PhotoFetchOptions) => Promise<PhotoResult>;
};

export type PhotoClientOptions = ApiClientOptions & {
  readonly now?: () => string;
};

const invalidResult = (error: ApiError): PhotoResult => ({
  ok: false,
  error,
  requestId: CLIENT_REQUEST_ID,
});

const base64 = (bytes: Uint8Array): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += alphabet[first >> 2];
    output += alphabet[((first & 3) << 4) | (second >> 4)];
    output += index + 1 < bytes.length ? alphabet[((second & 15) << 2) | (third >> 6)] : '=';
    output += index + 2 < bytes.length ? alphabet[third & 63] : '=';
  }
  return output;
};

const nowMilliseconds = (clock: () => string): number | null => {
  const value = Date.parse(clock());
  return Number.isFinite(value) ? value : null;
};

const parseDisplayDeadline = (
  displayUntil: string | null | undefined,
): number | null | 'invalid' => {
  if (displayUntil === undefined || displayUntil === null) return null;
  const deadline = Date.parse(displayUntil);
  return Number.isFinite(deadline) ? deadline : 'invalid';
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be disturbed or cancelled; the response remains unavailable.
  }
};

const readBoundedBytes = async (response: Response): Promise<Uint8Array | null> => {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_PHOTO_BYTES
  ) {
    await cancelResponseBody(response);
    return null;
  }
  if (response.body !== null && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        total += chunk.byteLength;
        if (total > MAX_PHOTO_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The body is already unusable; do not expose provider details.
          }
          return null;
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    await cancelResponseBody(response);
    return null;
  }
  return bytes;
};

const invalidContract = (requestId: string, issues: readonly string[]): PhotoResult =>
  issueResult(requestId, PHOTO_ROUTE, issues, null);

export const createJourneyPhotoClient = (options: PhotoClientOptions): JourneyPhotoClient => {
  const fetchImpl: ApiFetch = options.fetchImpl ?? fetch;
  const clock = options.now ?? (() => new Date().toISOString());

  const fetchPhoto = async (
    token: string,
    requestOptions: PhotoFetchOptions = {},
  ): Promise<PhotoResult> => {
    let requestId: string;
    try {
      requestId = options.requestIdFactory();
    } catch {
      return invalidResult({ kind: 'configuration', reason: 'invalid_request_id' });
    }
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return invalidResult({ kind: 'configuration', reason: 'invalid_request_id' });
    }
    const parsedPath = parsePhotoPath({ token });
    if (!parsedPath.success) return invalidContract(requestId, parsedPath.issues);
    const now = nowMilliseconds(clock);
    if (now === null) return invalidContract(requestId, ['photo clock is invalid']);
    const displayDeadline = parseDisplayDeadline(requestOptions.displayUntil);
    if (displayDeadline === 'invalid') {
      return invalidContract(requestId, ['photo display deadline is invalid']);
    }
    if (displayDeadline !== null && displayDeadline <= now) {
      return { ok: false, error: { kind: 'expired' }, requestId };
    }
    const timeoutMs = timeoutFor(requestOptions.timeoutMs, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (timeoutMs === null)
      return {
        ok: false,
        error: { kind: 'configuration', reason: 'invalid_timeout' },
        requestId,
      };
    const url = buildApiUrl(
      options.baseUrl,
      `/v1/photos/${encodeURIComponent(parsedPath.data.token)}`,
      options.mode,
    );
    if (url === null) {
      return { ok: false, error: { kind: 'configuration', reason: 'invalid_base_url' }, requestId };
    }
    if (requestOptions.signal?.aborted) return { ok: false, error: { kind: 'aborted' }, requestId };
    const deadlineAt = Date.now() + timeoutMs;
    const credentials = await runWithinDeadline(
      credentialHeaders(options, requestId),
      deadlineAt,
      requestOptions.signal,
    );
    if (credentials.kind === 'rejected') {
      return { ok: false, error: { kind: 'credentials', reason: 'unavailable' }, requestId };
    }
    if (credentials.kind !== 'done') {
      return { ok: false, error: { kind: credentials.kind }, requestId };
    }
    const auth = credentials.value;
    if (!auth.ok) return { ok: false, error: auth.error, requestId };
    if (requestOptions.signal?.aborted) return { ok: false, error: { kind: 'aborted' }, requestId };
    const afterCredentials = nowMilliseconds(clock);
    if (afterCredentials === null) return invalidContract(requestId, ['photo clock is invalid']);
    if (displayDeadline !== null && displayDeadline <= afterCredentials) {
      return { ok: false, error: { kind: 'expired' }, requestId };
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const work = (async (): Promise<PhotoResult> => {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: auth.headers,
        signal: controller.signal,
      });
      if (requestOptions.signal?.aborted)
        return { ok: false, error: { kind: 'aborted' }, requestId };
      if (!response.ok) {
        const headerRequestId = response.headers.get(REQUEST_ID_HEADER);
        const raw = await readJson(response);
        const parsedError = parsePublicError(raw);
        if (!parsedError.success)
          return issueResult(requestId, PHOTO_ROUTE, parsedError.issues, response.status);
        if (
          parsedError.data.requestId !== requestId ||
          parsedError.data.status !== response.status ||
          (headerRequestId !== null && headerRequestId !== requestId)
        ) {
          return issueResult(
            requestId,
            PHOTO_ROUTE,
            ['photo error identity does not match the request'],
            response.status,
          );
        }
        return {
          ok: false,
          requestId,
          error: {
            kind: 'http',
            status: response.status,
            publicError: parsedError.data,
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
          },
        };
      }
      if (response.status !== 200) {
        await cancelResponseBody(response);
        return invalidContract(requestId, ['unexpected success status']);
      }
      const responseRequestId = response.headers.get(REQUEST_ID_HEADER);
      if (responseRequestId !== requestId) {
        await cancelResponseBody(response);
        return invalidContract(requestId, ['photo response requestId does not match the request']);
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
      if (!IMAGE_TYPES.has(contentType)) {
        await cancelResponseBody(response);
        return invalidContract(requestId, ['photo response content type is not supported']);
      }
      const expiresHeader = response.headers.get('expires');
      const expiresAtMilliseconds = expiresHeader === null ? NaN : Date.parse(expiresHeader);
      const current = nowMilliseconds(clock);
      if (!Number.isFinite(expiresAtMilliseconds) || current === null) {
        await cancelResponseBody(response);
        return invalidContract(requestId, ['photo response expiry is invalid']);
      }
      const effectiveExpiry = Math.min(
        expiresAtMilliseconds,
        ...(displayDeadline === null ? [] : [displayDeadline]),
      );
      if (effectiveExpiry <= current) {
        await cancelResponseBody(response);
        return { ok: false, error: { kind: 'expired' }, requestId };
      }
      const bytes = await readBoundedBytes(response);
      if (bytes === null) return invalidContract(requestId, ['photo response is too large']);
      const completedAt = nowMilliseconds(clock);
      if (completedAt === null || effectiveExpiry <= completedAt) {
        return { ok: false, error: { kind: 'expired' }, requestId };
      }
      if (bytes.byteLength === 0) return invalidContract(requestId, ['photo response is empty']);
      return {
        ok: true,
        requestId,
        data: {
          uri: `data:${contentType};base64,${base64(bytes)}`,
          contentType,
          expiresAt: new Date(effectiveExpiry).toISOString(),
        },
      };
    })();
    const outcome = await runWithinDeadline(work, deadlineAt, requestOptions.signal, onAbort);
    requestOptions.signal?.removeEventListener('abort', onAbort);
    if (outcome.kind === 'rejected') return { ok: false, error: { kind: 'offline' }, requestId };
    if (outcome.kind !== 'done') return { ok: false, error: { kind: outcome.kind }, requestId };
    return outcome.value;
  };

  return { fetchPhoto };
};
