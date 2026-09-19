import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  REQUEST_ID_HEADER,
  parseRequestHeaders,
} from '@ima/contracts';
import type { ApiClientOptions, ApiCredentials, ApiError } from '@mobile/platform/http/api';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export type ApiCredentialHeadersResult =
  | { readonly ok: true; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly error: ApiError };

const isApiCredentials = (value: unknown): value is ApiCredentials =>
  typeof value === 'object' &&
  value !== null &&
  'appToken' in value &&
  typeof value.appToken === 'string' &&
  'deviceId' in value &&
  typeof value.deviceId === 'string' &&
  'ownerCredential' in value &&
  typeof value.ownerCredential === 'string';

export const buildApiUrl = (
  baseUrl: string,
  path: string,
  mode: ApiClientOptions['mode'],
): URL | null => {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    if (mode === 'live' && base.protocol !== 'https:') return null;
    if (mode === 'fixture' && base.protocol === 'http:' && !LOCAL_HOSTNAMES.has(base.hostname)) {
      return null;
    }
    return new URL(path.startsWith('/') ? path : `/${path}`, base);
  } catch {
    return null;
  }
};

export const timeoutFor = (candidate: number | undefined, fallback: number): number | null => {
  const value = candidate ?? fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

export const parseRetryAfter = (value: string | null): number | null => {
  if (value === null || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 ? seconds : null;
};

export const credentialHeaders = async (
  options: Pick<ApiClientOptions, 'credentials' | 'appVersion'>,
  requestId: string,
): Promise<ApiCredentialHeadersResult> => {
  let raw: unknown;
  try {
    raw =
      typeof options.credentials === 'function' ? await options.credentials() : options.credentials;
  } catch {
    return { ok: false, error: { kind: 'credentials', reason: 'unavailable' } };
  }
  if (!isApiCredentials(raw)) {
    return { ok: false, error: { kind: 'credentials', reason: 'missing' } };
  }
  const parsed = parseRequestHeaders({
    ...raw,
    requestId,
    appVersion: options.appVersion,
  });
  if (!parsed.success) return { ok: false, error: { kind: 'credentials', reason: 'invalid' } };
  return {
    ok: true,
    headers: {
      [APP_TOKEN_HEADER]: parsed.data.appToken,
      [DEVICE_ID_HEADER]: parsed.data.deviceId,
      [OWNER_CREDENTIAL_HEADER]: parsed.data.ownerCredential,
      [REQUEST_ID_HEADER]: parsed.data.requestId,
      [APP_VERSION_HEADER]: parsed.data.appVersion,
    },
  };
};
