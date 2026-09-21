import { describe, expect, it } from 'vitest';
import { APP_TOKEN_HEADER, REQUEST_ID_HEADER } from '@ima/contracts';
import { routeRequest } from '@worker/adapters/in/http/router';
import { makeHarness, makeRequest, requestId } from './router-fixtures';

describe('Hono routing compatibility', () => {
  it.each([
    ['GET', '/v1/prefs/', 404],
    ['POST', '/v1/search/', 404],
    ['GET', '/v1/threads/thread-1/', 404],
    ['GET', '/v1/threads/thread-1/replay/extra', 404],
    ['GET', '/v1/threads/thread-1/unknown', 404],
    ['GET', '/v1/threads//replay', 400],
    ['POST', '/v1/threads/', 400],
    ['GET', '/v1/photos/', 400],
    ['DELETE', '/v1/saved/', 400],
    ['GET', '/v1/saved//refresh', 400],
    ['GET', '/v%31/prefs', 404],
    ['GET', '/v1/%70refs', 404],
    ['GET', '/v1/threads/thread-1/%72eplay', 404],
    ['GET', '/v1/threads/a%2Fb', 400],
    ['DELETE', '/v1/saved/a%2Fb', 400],
    ['GET', '/v1/threads/%', 400],
    ['GET', '/v1/photos/%E0%A4%A', 400],
    ['GET', '/v1/saved/%FF/refresh', 400],
    ['GET', '/v1/threads/%2574hread-1', 400],
    ['PATCH', '/v1/threads/bad%2Fid/unknown', 400],
    ['PATCH', '/v1/threads/thread-1', 404],
    ['POST', '/v1/photos/token-1', 404],
    ['OPTIONS', '/v1/prefs', 404],
    ['POST', '/v1/attest/nonce', 400],
    ['GET', '/v1/attest/enroll', 400],
    ['DELETE', '/v1/attest/revoke', 400],
    ['POST', '/v1/attest/enroll/', 404],
    ['GET', '/v1/prefs?debug=true', 400],
    ['GET', '/v1/attest/nonce?debug=true', 400],
    ['POST', '/v1/threads?debug=true', 400],
    ['GET', '/v1/threads/thread-1?debug=true', 400],
    ['GET', '/v1/unknown?debug=true', 404],
  ])(
    'rejects %s %s with %i before authentication and side effects',
    async (method, path, status) => {
      const harness = makeHarness();
      const request = makeRequest(path, { method });
      request.headers.delete(APP_TOKEN_HEADER);
      const response = await routeRequest(request, harness.config);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        requestId,
        code: status === 400 ? 'INVALID_ARGUMENT' : 'NOT_FOUND',
      });
      expect(harness.calls.rate).toBe(0);
      expect(harness.calls.ownership).toEqual([]);
      expect(harness.calls.application).toBe(0);
      expect(harness.calls.events).toBe(0);
      expect(harness.calls.photo).toBe(0);
    },
  );

  it.each([
    ['/v1/prefs', 404],
    ['/v1/photos/photo-token-1', 404],
    ['/v1/photos/', 404],
    ['/v1/threads/thread-1', 404],
    ['/v1/threads/bad%2Fid', 400],
    ['/v1/attest/nonce', 400],
    ['/v1/attest/enroll', 400],
    ['/v1/attest/revoke', 400],
  ])('does not let Hono HEAD dispatch invoke GET work for %s', async (path, status) => {
    const harness = makeHarness();
    const response = await routeRequest(makeRequest(path, { method: 'HEAD' }), harness.config);
    expect(response.status).toBe(status);
    expect(harness.calls.rate).toBe(0);
    expect(harness.calls.application).toBe(0);
    expect(harness.calls.photo).toBe(0);
  });

  it.each([
    ['/v1/threads/%74hread-1', { kind: 'read_thread', path: { threadId: 'thread-1' } }],
    [
      '/v1/saved/%73aved-1/refresh',
      { kind: 'saved_reference_refresh', path: { savedPlaceRef: 'saved-1' } },
    ],
  ])('decodes valid dynamic path parameters once for %s', async (path, operation) => {
    const harness = makeHarness();
    const response = await routeRequest(makeRequest(path), harness.config);
    expect(response.status).toBe(200);
    expect(harness.calls.operations).toEqual([operation]);
  });

  it('keeps configuration and error request IDs isolated across concurrent requests', async () => {
    const first = makeHarness({ rate: { allowed: false, retryAfterSeconds: 3 } });
    const second = makeHarness({ rawApplicationError: true });
    const [firstResponse, secondResponse] = await Promise.all([
      routeRequest(
        makeRequest('/v1/prefs', { headers: { [REQUEST_ID_HEADER]: 'request-first' } }),
        first.config,
      ),
      routeRequest(
        makeRequest('/v1/prefs', { headers: { [REQUEST_ID_HEADER]: 'request-second' } }),
        second.config,
      ),
    ]);
    expect(firstResponse.status).toBe(429);
    expect(firstResponse.headers.get('retry-after')).toBe('3');
    expect(await firstResponse.json()).toMatchObject({ requestId: 'request-first' });
    expect(secondResponse.status).toBe(500);
    expect(await secondResponse.json()).toMatchObject({
      requestId: 'request-second',
      code: 'INTERNAL',
    });
    expect(first.calls.application).toBe(0);
    expect(second.calls.application).toBe(1);
  });
});
