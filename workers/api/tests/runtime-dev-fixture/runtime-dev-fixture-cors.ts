import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  DEVICE_ID_HEADER,
  OWNER_CREDENTIAL_HEADER,
  REQUEST_ID_HEADER,
} from '@ima/contracts';
import { isKeylessDevFixtureEnvironment } from '../../src/runtime/composition/runtime-dev-fixture';

const LOCAL_ORIGIN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const LOCAL_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const DEV_FIXTURE_CORS_ALLOWED_METHODS = ['GET', 'POST', 'DELETE'] as const;

/** Headers emitted by the mobile API client and therefore needed by browser preflight. */
export const DEV_FIXTURE_CORS_ALLOWED_HEADERS = [
  'content-type',
  APP_TOKEN_HEADER.toLowerCase(),
  DEVICE_ID_HEADER.toLowerCase(),
  OWNER_CREDENTIAL_HEADER.toLowerCase(),
  REQUEST_ID_HEADER.toLowerCase(),
  APP_VERSION_HEADER.toLowerCase(),
] as const;

const ALLOWED_METHODS = new Set<string>(DEV_FIXTURE_CORS_ALLOWED_METHODS);
const ALLOWED_HEADERS = new Set<string>(DEV_FIXTURE_CORS_ALLOWED_HEADERS);

const normalizedOrigin = (origin: string | null): string | null => {
  if (origin === null || origin.trim() !== origin) return null;
  try {
    const parsed = new URL(origin);
    if (
      !LOCAL_ORIGIN_PROTOCOLS.has(parsed.protocol) ||
      !LOCAL_ORIGIN_HOSTNAMES.has(parsed.hostname.toLowerCase()) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.origin !== origin
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const requestedHeaders = (value: string | null): string[] | null => {
  if (value === null || value.trim() === '') return [];
  const names = value.split(',').map((name) => name.trim().toLowerCase());
  if (names.some((name) => name === '' || !HEADER_NAME.test(name))) return null;
  const unique = [...new Set(names)];
  return unique.every((name) => ALLOWED_HEADERS.has(name)) ? unique : null;
};

const appendVaryOrigin = (headers: Headers): void => {
  const vary = headers.get('Vary');
  if (vary === null) {
    headers.set('Vary', 'Origin');
    return;
  }
  if (
    vary
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .includes('origin')
  ) {
    return;
  }
  headers.set('Vary', `${vary}, Origin`);
};

const responseWithCors = (response: Response, origin: string): Response => {
  const result = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  result.headers.set('Access-Control-Allow-Origin', origin);
  result.headers.set('Access-Control-Expose-Headers', `${REQUEST_ID_HEADER}, Retry-After, Expires`);
  appendVaryOrigin(result.headers);
  return result;
};

const forbiddenOrigin = (): Response => new Response(null, { status: 403 });

export type DevFixtureCorsHandler = () => Response | Promise<Response>;

/**
 * Adds browser CORS only at the keyless development fixture boundary.
 * Unknown origins and unsupported preflight requests are rejected before routing.
 */
export const withDevFixtureCors = async (
  request: Request,
  env: unknown,
  handler: DevFixtureCorsHandler,
): Promise<Response> => {
  if (!isKeylessDevFixtureEnvironment(env)) return handler();

  const origin = normalizedOrigin(request.headers.get('Origin'));
  if (request.headers.has('Origin') && origin === null) return forbiddenOrigin();

  if (request.method === 'OPTIONS' && origin !== null) {
    const method = request.headers.get('Access-Control-Request-Method');
    if (method !== null && !ALLOWED_METHODS.has(method.trim().toUpperCase())) {
      return forbiddenOrigin();
    }
    const headers = requestedHeaders(request.headers.get('Access-Control-Request-Headers'));
    if (headers === null) return forbiddenOrigin();
    if (method !== null) {
      const responseHeaders = new Headers({
        'Access-Control-Allow-Headers': headers.join(', '),
        'Access-Control-Allow-Methods': DEV_FIXTURE_CORS_ALLOWED_METHODS.join(', '),
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Max-Age': '600',
      });
      appendVaryOrigin(responseHeaders);
      return new Response(null, { status: 204, headers: responseHeaders });
    }
  }

  const response = await handler();
  return origin === null ? response : responseWithCors(response, origin);
};
