import * as v from 'valibot';
import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  OwnerCredentialHeaderSchema,
  OpaqueIdSchema,
  RequestHeadersSchema,
  REQUEST_ID_HEADER,
} from '@ima/contracts';
import type { BoundaryFailure } from '@worker/adapters/inbound/http/errors';
import { isValidRequestId } from '@worker/adapters/inbound/http/input';
import type { HandlerContext } from '@worker/adapters/inbound/http/handler';

export type AuthenticatedContext = Pick<
  HandlerContext,
  'requestId' | 'ownerScopeRef' | 'deviceId' | 'appVersion'
>;

export type AuthConfig = {
  readonly appToken: string;
  readonly requestIdFactory: () => string;
};

export type AuthenticationResult =
  | { readonly ok: true; readonly context: AuthenticatedContext }
  | { readonly ok: false; readonly requestId: string; readonly failure: BoundaryFailure };

const unauthorized = (): BoundaryFailure => ({ status: 401, code: 'UNAUTHORIZED' });
const invalidArgument = (): BoundaryFailure => ({ status: 400, code: 'INVALID_ARGUMENT' });
const invalidConfiguration = (): BoundaryFailure => ({ status: 500, code: 'INTERNAL' });

const generatedRequestId = (factory: () => string): string => {
  const candidate = factory();
  return v.safeParse(OpaqueIdSchema, candidate).success ? candidate : 'request-generated';
};

const requestIdForResponse = (request: Request, config: AuthConfig): string => {
  const supplied = request.headers.get(REQUEST_ID_HEADER);
  return isValidRequestId(supplied) ? supplied : generatedRequestId(config.requestIdFactory);
};

const requestHeaders = (request: Request): Record<string, string> => ({
  appToken: request.headers.get(APP_TOKEN_HEADER) ?? '',
  deviceId: request.headers.get(DEVICE_ID_HEADER) ?? '',
  ownerCredential: request.headers.get(OWNER_CREDENTIAL_HEADER) ?? '',
  requestId: request.headers.get(REQUEST_ID_HEADER) ?? '',
  appVersion: request.headers.get(APP_VERSION_HEADER) ?? '',
});

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

/** Hashes the validated credential; the raw credential never becomes an owner scope value. */
export const deriveOwnerScopeRef = async (credential: string): Promise<string | null> => {
  const valid = v.safeParse(OwnerCredentialHeaderSchema, credential);
  if (!valid.success) return null;
  const bytes = new TextEncoder().encode(valid.output);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `owner-${encodeBase64Url(new Uint8Array(digest))}`;
};

export const authenticateRequest = async (
  request: Request,
  config: AuthConfig,
): Promise<AuthenticationResult> => {
  const requestId = requestIdForResponse(request, config);
  if (config.appToken.length === 0) {
    return { ok: false, requestId, failure: invalidConfiguration() };
  }
  const raw = requestHeaders(request);

  if (raw.appToken !== config.appToken) {
    return { ok: false, requestId, failure: unauthorized() };
  }

  if (!v.safeParse(OwnerCredentialHeaderSchema, raw.ownerCredential).success) {
    return { ok: false, requestId, failure: unauthorized() };
  }

  const parsed = v.safeParse(RequestHeadersSchema, raw);
  if (!parsed.success) {
    return { ok: false, requestId, failure: invalidArgument() };
  }

  const ownerScopeRef = await deriveOwnerScopeRef(parsed.output.ownerCredential);
  if (ownerScopeRef === null) {
    return { ok: false, requestId, failure: unauthorized() };
  }

  return {
    ok: true,
    context: {
      requestId: parsed.output.requestId,
      ownerScopeRef,
      deviceId: parsed.output.deviceId,
      appVersion: parsed.output.appVersion,
    },
  };
};
