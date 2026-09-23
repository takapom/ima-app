import { SELF } from 'cloudflare:test';
import {
  APP_TOKEN_HEADER,
  APP_VERSION_HEADER,
  CreateThreadResponseSchema,
  DEVICE_ID_HEADER,
  ErrorResponseSchema,
  OWNER_CREDENTIAL_HEADER,
  REQUEST_ID_HEADER,
  SearchResponseSchema,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  DEV_FIXTURE_CORS_ALLOWED_HEADERS,
  DEV_FIXTURE_CORS_ALLOWED_METHODS,
  withDevFixtureCors,
} from './runtime-dev-fixture-cors';

const OWNER_CREDENTIAL = `${'A'.repeat(42)}E`;
const DEVICE_ID = 'dev-fixture-cors-device';
const APP_TOKEN = 'dev-fixture-app-token';
const APP_VERSION = 'm29-dev-fixture-cors-test';
const MOBILE_ORIGIN = 'http://localhost:3000';

const mobileHeaders = (requestId: string): Record<string, string> => ({
  [APP_TOKEN_HEADER]: APP_TOKEN,
  [DEVICE_ID_HEADER]: DEVICE_ID,
  [OWNER_CREDENTIAL_HEADER]: OWNER_CREDENTIAL,
  [REQUEST_ID_HEADER]: requestId,
  [APP_VERSION_HEADER]: APP_VERSION,
});

const call = (
  path: string,
  requestId: string,
  init: RequestInit = {},
  origin?: string,
): Promise<Response> => {
  const requestHeaders = new Headers(mobileHeaders(requestId));
  new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
  if (origin === undefined) requestHeaders.delete('Origin');
  else requestHeaders.set('Origin', origin);
  return SELF.fetch(`https://ima.dev${path}`, { ...init, headers: requestHeaders });
};

const preflight = (
  path: string,
  origin: string,
  method: string,
  requestedHeaders?: string,
): Promise<Response> =>
  SELF.fetch(`https://ima.dev${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': method,
      ...(requestedHeaders === undefined
        ? {}
        : { 'Access-Control-Request-Headers': requestedHeaders }),
    },
  });

const corsHealth = (env: Record<string, string>): Promise<Response> =>
  withDevFixtureCors(
    new Request('https://ima.dev/health', {
      method: 'GET',
      headers: { Origin: MOBILE_ORIGIN },
    }),
    env,
    () => Response.json({ status: 'ok' }),
  );

const expectCorsOrigin = (
  response: Response,
  origin: string,
  options: { readonly actual?: boolean } = {},
): void => {
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  if (options.actual === true) {
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain(REQUEST_ID_HEADER);
  }
  expect(response.headers.get('Vary')?.toLowerCase()).toContain('origin');
};

const createThread = async (origin: string): Promise<{ threadId: string; response: Response }> => {
  const requestId = `dev-fixture-cors-create-${crypto.randomUUID()}`;
  const response = await call(
    '/v1/threads',
    requestId,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId,
        idempotencyKey: `dev-fixture-cors-create-key-${crypto.randomUUID()}`,
      }),
    },
    origin,
  );
  expect(response.status).toBe(201);
  expectCorsOrigin(response, origin, { actual: true });
  const parsed = v.safeParse(CreateThreadResponseSchema, await response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('dev fixture CORS thread response was invalid');
  return { threadId: parsed.output.threadId, response };
};

describe('keyless dev fixture CORS boundary', () => {
  it('handles mobile preflight and returns cards for an origin-bound cafe search', async () => {
    const preflightResponse = await preflight(
      '/v1/threads',
      MOBILE_ORIGIN,
      'POST',
      DEV_FIXTURE_CORS_ALLOWED_HEADERS.join(', '),
    );
    expect(preflightResponse.status).toBe(204);
    expectCorsOrigin(preflightResponse, MOBILE_ORIGIN);
    expect(preflightResponse.headers.get('Access-Control-Allow-Methods')).toBe(
      DEV_FIXTURE_CORS_ALLOWED_METHODS.join(', '),
    );
    expect(preflightResponse.headers.get('Access-Control-Allow-Headers')).toBe(
      DEV_FIXTURE_CORS_ALLOWED_HEADERS.join(', '),
    );
    expect(preflightResponse.headers.get('Access-Control-Max-Age')).toBe('600');

    const { threadId } = await createThread(MOBILE_ORIGIN);
    const requestId = `dev-fixture-cors-turn-${crypto.randomUUID()}`;
    const response = await call(
      `/v1/threads/${encodeURIComponent(threadId)}/turns`,
      requestId,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 'v1',
          requestId,
          turnId: null,
          revision: 1,
          text: 'カフェ',
          clientNow: '2026-09-11T03:00:00.000Z',
          location: {
            status: 'unavailable',
            lat: null,
            lng: null,
            accuracyMeters: null,
            precise: false,
            capturedAt: null,
          },
          prefs: {
            areaText: null,
            budget: null,
          },
          savedPlaceRefs: [],
          excludeCandidateIds: [],
          mode: 'search',
          idempotencyKey: `dev-fixture-cors-turn-key-${crypto.randomUUID()}`,
        }),
      },
      MOBILE_ORIGIN,
    );
    expect(response.status).toBe(200);
    expectCorsOrigin(response, MOBILE_ORIGIN, { actual: true });
    const parsed = v.safeParse(SearchResponseSchema, await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('dev fixture CORS search response was invalid');
    expect(parsed.output.response.kind).toBe('cards');
  });

  it.each(['http://localhost:3000', 'https://127.0.0.1:5173', 'http://[::1]:8787'])(
    'allows local browser origin %s in preflight',
    async (origin) => {
      const response = await preflight('/health', origin, 'GET', 'content-type');
      expect(response.status).toBe(204);
      expectCorsOrigin(response, origin);
    },
  );

  it.each([
    ['an unsupported method', 'PATCH', 'content-type'],
    ['an unsupported header', 'POST', 'content-type, x-not-allowed'],
  ])('rejects preflight with %s', async (_label, method, headers) => {
    const response = await preflight('/health', MOBILE_ORIGIN, method, headers);
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it.each([
    ['staging', { IMA_ENV: 'staging', IMA_RUNTIME_MODE: 'fixture' }],
    ['production', { IMA_ENV: 'production', IMA_RUNTIME_MODE: 'fixture' }],
    ['kill switch', { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'fixture', IMA_KILL_SWITCH: 'true' }],
  ])('keeps the entry CORS gate disabled for %s', async (_label, overrides) => {
    const response = await corsHealth(overrides);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds CORS to an actual error and preserves responses without Origin', async () => {
    const errorRequestId = `dev-fixture-cors-error-${crypto.randomUUID()}`;
    const error = await call(
      '/v1/unknown',
      errorRequestId,
      { method: 'GET' },
      'https://127.0.0.1:5173',
    );
    expect(error.status).toBe(404);
    expectCorsOrigin(error, 'https://127.0.0.1:5173', { actual: true });
    const parsed = v.safeParse(ErrorResponseSchema, await error.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('dev fixture CORS error response was invalid');

    const requestId = `dev-fixture-cors-no-origin-${crypto.randomUUID()}`;
    const response = await call('/health', requestId, { method: 'GET' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Vary')).toBeNull();
  });

  it('rejects an origin outside the local development allowlist', async () => {
    const response = await call(
      '/health',
      `dev-fixture-cors-unknown-${crypto.randomUUID()}`,
      { method: 'GET' },
      'https://example.com',
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
