import { expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

it('serves the worker health endpoint for GET in the Workers runtime', async () => {
  const response = await SELF.fetch('https://ima.test/health');
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload).toEqual({ status: 'ok' });
});

it('rejects a non-GET health request', async () => {
  const response = await SELF.fetch('https://ima.test/health', {
    method: 'POST',
  });

  expect(response.status).toBe(404);
});

it('returns 404 for an unknown path', async () => {
  const response = await SELF.fetch('https://ima.test/unknown');

  expect(response.status).toBe(404);
});
