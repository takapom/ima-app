import { HttpBoundaryError } from '@worker/adapters/inbound/http/errors';
import type {
  HandlerContext,
  PhotoBodyHandler,
  PhotoPath,
} from '@worker/adapters/inbound/http/handler';
import { PhotoProviderError, type PhotoMediaTransport } from '@worker/runtime/ports/photo-media';
import type { RuntimeProviderTransportObserver } from '@worker/runtime/tracing/runtime-provider-trace-contract';
import {
  PhotoTokenError,
  type PhotoHandleClaims,
  type PhotoTokenCodec,
  type PhotoTransportTraceIdentity,
} from '@worker/runtime/ports/photo';

const tokenFailure = (error: PhotoTokenError): HttpBoundaryError => {
  switch (error.code) {
    case 'EXPIRED':
    case 'REFERENCE_UNAVAILABLE':
      return new HttpBoundaryError({ status: 410, code: 'EXPIRED' });
    case 'INVALID_TOKEN':
    case 'SCOPE_MISMATCH':
      return new HttpBoundaryError({ status: 403, code: 'FORBIDDEN' });
    case 'INVALID_INPUT':
      return new HttpBoundaryError({ status: 400, code: 'INVALID_ARGUMENT' });
    case 'MISSING_SECRET':
    case 'REFERENCE_RESOLVER_REQUIRED':
    case 'TOKEN_TOO_LARGE':
    case 'REFERENCE_CONFLICT':
      return new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  }
};

const providerFailure = (error: PhotoProviderError): HttpBoundaryError => {
  switch (error.code) {
    case 'CANCELLED':
      return new HttpBoundaryError({ status: 409, code: 'CANCELLED' });
    case 'EXPIRED':
      return new HttpBoundaryError({ status: 410, code: 'EXPIRED' });
    case 'RATE_LIMITED':
      return new HttpBoundaryError(
        { status: 429, code: 'RATE_LIMITED' },
        error.retryAfterMs === null
          ? {}
          : { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) },
      );
    case 'RESULT_TOO_LARGE':
      return new HttpBoundaryError({ status: 413, code: 'RESULT_TOO_LARGE' });
    case 'UNSUPPORTED_MEDIA_TYPE':
      return new HttpBoundaryError({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    case 'TIMEOUT':
      return new HttpBoundaryError({ status: 504, code: 'TIMEOUT' });
    case 'MISSING_API_KEY':
    case 'INVALID_REQUEST':
    case 'UPSTREAM_UNAVAILABLE':
    case 'REDIRECT_REJECTED':
      return new HttpBoundaryError({ status: 502, code: 'PROVIDER_UNAVAILABLE' });
  }
};

const tokenClaims = async (codec: PhotoTokenCodec, path: PhotoPath, context: HandlerContext) => {
  try {
    return await codec.verify(
      path.token,
      { ownerScopeRef: context.ownerScopeRef, deviceId: context.deviceId },
      context.serverNow,
    );
  } catch (error: unknown) {
    if (error instanceof PhotoTokenError) throw tokenFailure(error);
    throw error;
  }
};

const traceIdentityFor = (claims: PhotoHandleClaims): PhotoTransportTraceIdentity | undefined => {
  if (claims.turnId === undefined || claims.revision === undefined) return undefined;
  return {
    ownerScopeRef: claims.ownerScopeRef,
    threadId: claims.threadId,
    turnId: claims.turnId,
    revision: claims.revision,
  };
};

/**
 * Worker-only adapter joining authenticated token scope to the bounded provider stream.
 * Provider references and API credentials remain inside this adapter.
 */
export const createPhotoBodyHandler = (options: {
  readonly tokenCodec: PhotoTokenCodec;
  readonly transport: PhotoMediaTransport;
  /** Builds a trace observer only when the verified reference carries its source turn identity. */
  readonly providerTraceObserverFor?: (
    identity: PhotoTransportTraceIdentity,
  ) => RuntimeProviderTransportObserver | undefined;
}): PhotoBodyHandler => ({
  async authorize(path, context): Promise<void> {
    await tokenClaims(options.tokenCodec, path, context);
  },

  async read(path, context) {
    const claims = await tokenClaims(options.tokenCodec, path, context);
    try {
      const traceIdentity = traceIdentityFor(claims);
      const observer =
        traceIdentity === undefined
          ? undefined
          : (() => {
              try {
                return options.providerTraceObserverFor?.(traceIdentity);
              } catch {
                return undefined;
              }
            })();
      const media = await options.transport.read(claims.photoRef, context.signal, observer);
      const descriptor = {
        schemaVersion: 'v1' as const,
        requestId: context.requestId,
        token: path.token,
        contentType: media.contentType,
        expiresAt: claims.expiresAt,
      };
      return { descriptor, body: media.body };
    } catch (error: unknown) {
      if (error instanceof PhotoProviderError) throw providerFailure(error);
      throw error;
    }
  },
});
