import * as v from 'valibot';
import {
  DEFAULT_PHOTO_MAX_BYTES,
  DEFAULT_PHOTO_TIMEOUT_MS,
  PhotoContentTypeSchema,
  PhotoProviderError,
  type PhotoMediaTransport,
} from '@worker/runtime/ports/photo-media';
import { HotPepperPhotoUrlSchema } from '@worker/security/photo-resource-policy';
import {
  beginRuntimeProviderTransportCall,
  completeRuntimeProviderTransportCall,
} from '@worker/runtime/tracing/runtime-provider-trace-contract';

const readImage = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) throw new PhotoProviderError('RESULT_TOO_LARGE');
  if (response.body === null) throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new PhotoProviderError('RESULT_TOO_LARGE');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (size === 0) throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Uses the public image URL returned by Gourmet Search; no second provider key is needed. */
export const createHotPepperPhotoTransport = (
  options: {
    readonly fetcher?: typeof fetch;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
  } = {},
): PhotoMediaTransport => ({
  async read(photoRef, signal, observer) {
    if (!v.is(HotPepperPhotoUrlSchema, photoRef)) throw new PhotoProviderError('INVALID_REQUEST');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, options.timeoutMs ?? DEFAULT_PHOTO_TIMEOUT_MS);
    const call = beginRuntimeProviderTransportCall(observer, { provider: 'photo' });
    try {
      const response = await (options.fetcher ?? fetch)(photoRef, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/jpeg,image/png,image/webp,image/gif' },
      });
      if (response.status >= 300 && response.status < 400)
        throw new PhotoProviderError('REDIRECT_REJECTED');
      if (response.status === 404 || response.status === 410)
        throw new PhotoProviderError('EXPIRED');
      if (!response.ok) throw new PhotoProviderError('UPSTREAM_UNAVAILABLE');
      const type = v.safeParse(
        PhotoContentTypeSchema,
        response.headers.get('content-type')?.split(';')[0]?.trim(),
      );
      if (!type.success) throw new PhotoProviderError('UNSUPPORTED_MEDIA_TYPE');
      const bytes = await readImage(response, options.maxBytes ?? DEFAULT_PHOTO_MAX_BYTES);
      completeRuntimeProviderTransportCall(call, { status: 'ok' });
      return {
        contentType: type.output,
        contentLength: bytes.byteLength,
        body: new ReadableStream<Uint8Array>({
          start: (stream) => {
            stream.enqueue(bytes);
            stream.close();
          },
        }),
      };
    } catch (error) {
      const failure = signal?.aborted
        ? new PhotoProviderError('CANCELLED')
        : controller.signal.aborted
          ? new PhotoProviderError('TIMEOUT')
          : error instanceof PhotoProviderError
            ? error
            : new PhotoProviderError('UPSTREAM_UNAVAILABLE');
      completeRuntimeProviderTransportCall(call, {
        status: 'error',
        error: failure,
        ...(signal === undefined ? {} : { signal }),
      });
      throw failure;
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  },
});
