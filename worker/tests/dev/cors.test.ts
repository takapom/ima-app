import { describe, expect, it, vi } from 'vitest';
import {
  DEV_CORS_ALLOWED_HEADERS,
  DEV_CORS_ALLOWED_METHODS,
  withDevCors,
} from '../../tooling/dev/cors';

const live = { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'live' };
const origin = 'http://localhost:8081';
const request = (headers: Record<string, string>, method = 'OPTIONS') =>
  new Request('https://ima.dev/health', { method, headers });

describe('live development CORS', () => {
  it.each(['http://localhost:3000', 'https://127.0.0.1:5173', 'http://[::1]:8787'])(
    'allows local preflight for %s without executing the handler',
    async (localOrigin) => {
      const handler = vi.fn(() => new Response(null, { status: 500 }));
      const response = await withDevCors(
        request({
          Origin: localOrigin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': DEV_CORS_ALLOWED_HEADERS.join(', '),
        }),
        live,
        handler,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(localOrigin);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        DEV_CORS_ALLOWED_METHODS.join(', '),
      );
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        DEV_CORS_ALLOWED_HEADERS.join(', '),
      );
      expect(response.headers.get('Vary')).toBe('Origin');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    { Origin: 'https://example.com' },
    { Origin: 'http://localhost:8081/path' },
    { Origin: origin, 'Access-Control-Request-Method': 'PATCH' },
    { Origin: origin, 'Access-Control-Request-Headers': 'content-type, x-not-allowed' },
  ])('rejects unsupported preflight before routing: %j', async (headers) => {
    const handler = vi.fn(() => new Response(null));
    const response = await withDevCors(request(headers), live, handler);
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { IMA_ENV: 'staging', IMA_RUNTIME_MODE: 'live' },
    { IMA_ENV: 'production', IMA_RUNTIME_MODE: 'live' },
    { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'fixture' },
    { IMA_ENV: 'dev', IMA_RUNTIME_MODE: 'disabled' },
  ])('does not enable development CORS for %j', async (environment) => {
    const response = await withDevCors(
      request({ Origin: origin }, 'GET'),
      environment,
      () => new Response(null),
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('preserves error responses and existing Vary headers', async () => {
    const response = await withDevCors(
      request({ Origin: origin }, 'GET'),
      live,
      () =>
        new Response('unavailable', {
          status: 503,
          headers: { Vary: 'Accept', 'Retry-After': '1' },
        }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('unavailable');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
    expect(response.headers.get('Vary')).toBe('Accept, Origin');
  });

  it('returns the original response when there is no Origin', async () => {
    const original = new Response('ok');
    expect(await withDevCors(request({}, 'GET'), live, () => original)).toBe(original);
  });
});
