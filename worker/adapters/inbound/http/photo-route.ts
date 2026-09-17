import { PhotoBinaryRouteResponseSchema } from '@ima/contracts';
import * as v from 'valibot';
import type {
  HandlerContext,
  PhotoBodyHandler,
  PhotoPath,
} from '@worker/adapters/inbound/http/handler';
import { toErrorResponse } from '@worker/adapters/inbound/http/errors';

const internal = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 500, code: 'INTERNAL' });

const expired = (requestId: string): Response =>
  toErrorResponse(requestId, { status: 410, code: 'EXPIRED' });

/** Validate the photo descriptor and keep body cleanup beside the binary response boundary. */
export const ensurePhotoResponse = async (
  path: PhotoPath,
  requestId: string,
  context: HandlerContext,
  photo: PhotoBodyHandler,
  serverNow: () => string,
): Promise<Response> => {
  const result = await photo.read(path, context);
  const releaseBody = async (): Promise<void> => {
    if (!(result.body instanceof ReadableStream)) return;
    try {
      await result.body.cancel();
    } catch {
      // The public response is already invalid; cleanup cannot make it usable.
    }
  };
  const parsed = v.safeParse(PhotoBinaryRouteResponseSchema, {
    bodyKind: 'binary' as const,
    descriptor: result.descriptor,
  });
  if (
    !parsed.success ||
    (!(result.body instanceof Uint8Array) && !(result.body instanceof ReadableStream)) ||
    parsed.output.descriptor.requestId !== requestId ||
    parsed.output.descriptor.token !== path.token
  ) {
    await releaseBody();
    return internal(requestId);
  }
  const now = Date.parse(serverNow());
  const expiresAt = Date.parse(parsed.output.descriptor.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
    await releaseBody();
    return internal(requestId);
  }
  if (expiresAt <= now) {
    await releaseBody();
    return expired(requestId);
  }
  const body =
    result.body instanceof Uint8Array
      ? (() => {
          const copy = new Uint8Array(result.body.byteLength);
          copy.set(result.body);
          return copy;
        })()
      : result.body;
  return new Response(body, {
    status: 200,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': parsed.output.descriptor.contentType,
      expires: new Date(expiresAt).toUTCString(),
      'x-ima-request-id': requestId,
    },
  });
};
