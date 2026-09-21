import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createBootstrapAppIntegrityGate } from '@worker/composition/app-integrity-bootstrap';
import { createHttpRouterConfig, type BootstrapEnv } from '@worker/composition/bootstrap';
import { personalPreviewEnabled } from '@worker/composition/personal-preview';
import { DurableRateLimiter } from '@worker/adapters/out/persistence/security/durable-rate-limiter';
import { routeRequest } from '@worker/adapters/in/http/router';
import { makeHarness, makeRequest, searchInput, type Harness } from '../router-fixtures';

const token = 'a1'.repeat(32);
const personal = {
  IMA_ENV: 'staging',
  IMA_PERSONAL_PREVIEW: 'true',
  APP_TOKEN: token,
};

function hasBindings(value: unknown): value is Pick<BootstrapEnv, 'THREADS' | 'RATE_LIMITS'> {
  return (
    typeof value === 'object' && value !== null && 'THREADS' in value && 'RATE_LIMITS' in value
  );
}

// Keep bootstrap authentication/rate-limit wiring; only product results are fixtures.
const fixtureConfig = (harness: Harness) => {
  if (!hasBindings(env)) throw new Error('PREVIEW_TEST_BINDINGS_MISSING');
  const config = createHttpRouterConfig(
    { ...env, ...personal },
    { ownership: harness.config.ownership, clock: harness.config.now },
  );
  return {
    ...config,
    handlers: { ...harness.config.handlers, rateLimiter: config.handlers.rateLimiter },
  };
};

describe('personally signed staging preview', () => {
  it('requires staging, explicit opt-in, and a 256-bit hex token', () => {
    expect(personalPreviewEnabled(personal)).toBe(true);
    for (const env of [
      { ...personal, IMA_ENV: 'production' },
      { ...personal, IMA_ENV: 'dev' },
      { ...personal, IMA_ENV: 'typo' },
      { ...personal, IMA_PERSONAL_PREVIEW: 'false' },
      { ...personal, IMA_PERSONAL_PREVIEW: 'TRUE' },
      { ...personal, APP_TOKEN: 'local-only-token' },
      { ...personal, APP_TOKEN: '' },
      { IMA_ENV: 'staging' },
    ]) {
      expect(personalPreviewEnabled(env)).toBe(false);
    }
  });

  it('accepts an authenticated personal preview without an assertion', async () => {
    const harness = makeHarness();
    const response = await routeRequest(
      makeRequest('/v1/search', {
        method: 'POST',
        headers: { 'X-App-Token': token },
        json: searchInput,
      }),
      fixtureConfig(harness),
    );
    expect(response.status).toBe(200);
  });

  it('still rejects a wrong token and invalid owner credentials', async () => {
    const harness = makeHarness();
    for (const headers of [
      { 'X-App-Token': 'wrong' },
      { 'X-App-Token': token, 'X-Ima-Owner-Credential': 'invalid' },
      { 'X-App-Token': token, 'X-App-Attest-Assert': 'invalid' },
    ]) {
      const response = await routeRequest(
        makeRequest('/v1/search', { method: 'POST', headers, json: searchInput }),
        fixtureConfig(harness),
      );
      expect(response.status).toBe(401);
    }
    expect(harness.calls.application).toBe(0);
  });

  it('keeps ordinary staging and production fail-closed', async () => {
    const harness = makeHarness();
    for (const env of [
      { ...personal, IMA_ENV: 'production' },
      { ...personal, IMA_PERSONAL_PREVIEW: 'false' },
      { ...personal, APP_TOKEN: 'local-only-token' },
    ]) {
      const gate = createBootstrapAppIntegrityGate(env);
      expect(gate.enforcement).toBe('required');
      const response = await routeRequest(
        makeRequest('/v1/search', {
          method: 'POST',
          headers: { 'X-App-Token': token },
          json: searchInput,
        }),
        {
          ...harness.config,
          auth: { ...harness.config.auth, appToken: token },
          appIntegrity: gate,
        },
      );
      expect(response.status).toBe(401);
    }
  });

  it('still enforces ownership before running a search', async () => {
    const harness = makeHarness({ denyKind: 'thread' });
    const response = await routeRequest(
      makeRequest('/v1/search', {
        method: 'POST',
        headers: { 'X-App-Token': token },
        json: searchInput,
      }),
      fixtureConfig(harness),
    );
    expect(response.status).toBe(403);
    expect(harness.calls.application).toBe(0);
  });

  it('allows more than both hourly caps without consulting an exhausted limiter', async () => {
    const limited = vi.spyOn(DurableRateLimiter.prototype, 'check').mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 3_600,
    });
    try {
      const harness = makeHarness();
      const config = fixtureConfig(harness);
      for (let index = 0; index < 101; index += 1) {
        const response = await routeRequest(
          makeRequest('/v1/search', {
            method: 'POST',
            headers: { 'X-App-Token': token },
            json: searchInput,
          }),
          config,
        );
        expect(response.status).toBe(200);
      }
      expect(harness.calls.application).toBe(101);
      expect(limited).not.toHaveBeenCalled();
    } finally {
      limited.mockRestore();
    }
  });

  it.each([
    { ...personal, IMA_ENV: 'production' },
    { ...personal, IMA_ENV: 'dev' },
    { ...personal, IMA_ENV: 'typo' },
    { ...personal, IMA_PERSONAL_PREVIEW: 'false' },
    { ...personal, IMA_PERSONAL_PREVIEW: 'TRUE' },
    { ...personal, APP_TOKEN: 'local-only-token' },
    { IMA_ENV: 'staging', APP_TOKEN: token },
  ])('retains both durable limits outside personal preview: %j', async (settings) => {
    if (!hasBindings(env)) throw new Error('PREVIEW_TEST_BINDINGS_MISSING');
    const config = createHttpRouterConfig(
      { ...env, ...settings },
      {
        ownership: makeHarness().config.ownership,
        rateLimit: { windowMs: 3_600_000, devicePerWindow: 1, ownerPerWindow: 2 },
      },
    );
    const input = {
      route: 'search',
      ownerScopeRef: `owner-${crypto.randomUUID()}`,
      deviceId: `device-${crypto.randomUUID()}`,
    };
    const limiter = config.handlers.rateLimiter;
    expect((await limiter.check(input)).allowed).toBe(true);
    expect((await limiter.check(input)).allowed).toBe(false);
    expect((await limiter.check({ ...input, deviceId: `${input.deviceId}-2` })).allowed).toBe(true);
    const ownerLimited = await limiter.check({ ...input, deviceId: `${input.deviceId}-3` });
    expect(ownerLimited.allowed).toBe(false);
    expect(ownerLimited.retryAfterSeconds).toBeGreaterThan(0);
  });
});
