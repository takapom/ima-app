import {
  AppAttestEnrollResponseSchema,
  AppAttestNonceResponseSchema,
  AppAttestRevokeResponseSchema,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { routeRequest } from '../../src/http/router';
import type { AppIntegrityGate } from '../../src/security/app-integrity';
import { makeHarness, makeRequest, requestId } from './router-fixtures';

const NOW = '2026-09-10T00:00:00.000Z';

const gateFor = (overrides: Partial<AppIntegrityGate> = {}): AppIntegrityGate => ({
  enforcement: 'required',
  environment: 'production',
  issueNonce: () =>
    Promise.resolve({
      schemaVersion: 'v1',
      requestId,
      nonce: 'nonce-route',
      expiresAt: '2026-09-10T00:05:00.000Z',
    }),
  enroll: () => Promise.resolve({ registered: true as const }),
  authorize: () => Promise.resolve({ allowed: false as const, code: 'ASSERTION_MISSING' as const }),
  revoke: () => Promise.resolve(true),
  ...overrides,
});

const readJson = async (response: Response): Promise<unknown> => response.json();

describe('App Integrity HTTP lifecycle routes', () => {
  it('issues a nonce after shared authentication and rate admission', async () => {
    const harness = makeHarness({ serverNow: NOW });
    const seen: Array<{ ownerScopeRef: string; deviceId: string; requestId: string; now: string }> =
      [];
    const response = await routeRequest(makeRequest('/v1/attest/nonce', { method: 'GET' }), {
      ...harness.config,
      appIntegrity: gateFor({
        issueNonce: (input) => {
          seen.push(input);
          return Promise.resolve({
            schemaVersion: 'v1',
            requestId: input.requestId,
            nonce: 'nonce-route',
            expiresAt: '2026-09-10T00:05:00.000Z',
          });
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(v.safeParse(AppAttestNonceResponseSchema, await readJson(response)).success).toBe(true);
    expect(seen).toHaveLength(1);
    const nonceInput = seen[0];
    if (nonceInput === undefined) throw new Error('expected nonce input');
    expect(nonceInput.ownerScopeRef).toMatch(/^owner-/);
    expect(nonceInput).toMatchObject({ deviceId: 'device-1', requestId, now: NOW });
    expect(harness.calls.rate).toBe(1);
    expect(harness.calls.application).toBe(0);

    const mismatched = await routeRequest(makeRequest('/v1/attest/nonce', { method: 'GET' }), {
      ...harness.config,
      appIntegrity: gateFor({
        issueNonce: () =>
          Promise.resolve({
            schemaVersion: 'v1',
            requestId: 'other-request',
            nonce: 'nonce-route',
            expiresAt: '2026-09-10T00:05:00.000Z',
          }),
      }),
    });
    expect(mismatched.status).toBe(401);
  });

  it('enrolls only a strict, request-bound body through the injected verifier gate', async () => {
    const harness = makeHarness({ serverNow: NOW });
    const seen: Array<{ ownerScopeRef: string; deviceId: string; request: unknown; now: string }> =
      [];
    const response = await routeRequest(
      makeRequest('/v1/attest/enroll', {
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          keyId: 'key-route',
          nonce: 'nonce-route',
          attestation: 'opaque-attestation',
        },
      }),
      {
        ...harness.config,
        appIntegrity: gateFor({
          enroll: (input) => {
            seen.push(input);
            return Promise.resolve({ registered: true as const });
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(v.safeParse(AppAttestEnrollResponseSchema, await readJson(response)).success).toBe(true);
    expect(seen).toHaveLength(1);
    const enrollInput = seen[0];
    if (enrollInput === undefined) throw new Error('expected enroll input');
    expect(enrollInput.ownerScopeRef).toMatch(/^owner-/);
    expect(enrollInput).toMatchObject({
      deviceId: 'device-1',
      request: {
        schemaVersion: 'v1',
        requestId,
        keyId: 'key-route',
        nonce: 'nonce-route',
        attestation: 'opaque-attestation',
      },
      now: NOW,
    });

    const invalid = await routeRequest(
      makeRequest('/v1/attest/enroll', {
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          keyId: 'key-route',
          nonce: 'nonce-route',
          attestation: 'opaque-attestation',
          unexpected: 'raw-secret',
        },
      }),
      { ...harness.config, appIntegrity: gateFor() },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('raw-secret');
  });

  it('revokes only the authenticated owner/device key and keeps key material out of output', async () => {
    const harness = makeHarness({ serverNow: NOW });
    const seen: Array<{ ownerScopeRef: string; deviceId: string; keyId: string }> = [];
    const response = await routeRequest(
      makeRequest('/v1/attest/revoke', {
        method: 'POST',
        json: { schemaVersion: 'v1', requestId, keyId: 'key-route' },
      }),
      {
        ...harness.config,
        appIntegrity: gateFor({
          revoke: (input) => {
            seen.push(input);
            return Promise.resolve(true);
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    const responseBody = await readJson(response);
    expect(v.safeParse(AppAttestRevokeResponseSchema, responseBody).success).toBe(true);
    expect(seen).toHaveLength(1);
    const revokeInput = seen[0];
    if (revokeInput === undefined) throw new Error('expected revoke input');
    expect(revokeInput.ownerScopeRef).toMatch(/^owner-/);
    expect(revokeInput).toMatchObject({ deviceId: 'device-1', keyId: 'key-route' });
    expect(JSON.stringify(responseBody)).not.toContain('opaque');
  });

  it('stops lifecycle routes before the injected gate when rate admission denies', async () => {
    const harness = makeHarness({
      serverNow: NOW,
      rate: { allowed: false, retryAfterSeconds: 11 },
    });
    let calls = 0;
    const response = await routeRequest(makeRequest('/v1/attest/nonce', { method: 'GET' }), {
      ...harness.config,
      appIntegrity: gateFor({
        issueNonce: () => {
          calls += 1;
          return Promise.reject(new Error('must not run'));
        },
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('11');
    expect(calls).toBe(0);
  });

  it('fails closed when no gate/verifier is injected', async () => {
    const harness = makeHarness({ serverNow: NOW });
    const response = await routeRequest(
      makeRequest('/v1/attest/nonce', { method: 'GET' }),
      harness.config,
    );
    expect(response.status).toBe(401);
    const enroll = await routeRequest(
      makeRequest('/v1/attest/enroll', {
        method: 'POST',
        json: {
          schemaVersion: 'v1',
          requestId,
          keyId: 'key-route',
          nonce: 'nonce-route',
          attestation: 'opaque-attestation',
        },
      }),
      harness.config,
    );
    expect(enroll.status).toBe(401);
  });
});
