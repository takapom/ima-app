import * as v from 'valibot';
import type { RuntimeProviderTransportObserver } from '@worker/infrastructure/runtime/tracing/runtime-provider-trace-contract';

export const DEFAULT_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_PHOTO_METADATA_MAX_BYTES = 64 * 1024;
export const DEFAULT_PHOTO_TIMEOUT_MS = 10_000;
export const DEFAULT_PHOTO_MAX_WIDTH_PX = 1_600;

export const PhotoContentTypeSchema = v.picklist([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
export type PhotoContentType = v.InferOutput<typeof PhotoContentTypeSchema>;

export type PhotoMedia = {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: PhotoContentType;
  readonly contentLength: number | null;
};

export type PhotoMediaTransport = {
  read(
    photoRef: string,
    signal?: AbortSignal,
    observer?: RuntimeProviderTransportObserver,
  ): Promise<PhotoMedia>;
};

export type PhotoProviderErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'EXPIRED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RESULT_TOO_LARGE'
  | 'REDIRECT_REJECTED';

export class PhotoProviderError extends Error {
  readonly code: PhotoProviderErrorCode;
  readonly retryAfterMs: number | null;

  constructor(code: PhotoProviderErrorCode, retryAfterMs: number | null = null) {
    super(`photo provider failed: ${code}`);
    this.name = 'PhotoProviderError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
