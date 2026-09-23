import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  AppAttestEnrollResponseSchema,
  AppAttestNonceResponseSchema,
  AppAttestRevokeResponseSchema,
} from '@ima/contracts';

const APP_TOKEN = 'test-app-token';
const OWNER_A = 'A'.repeat(43);
const OWNER_B = 'B'.repeat(43);
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';

type Json = Record<string, unknown>;

const headers = (owner: string, device: string, requestId: string): HeadersInit => ({
  'content-type': 'application/json',
  'x-app-token': APP_TOKEN,
  'x-device-id': device,
  'x-ima-owner-credential': owner,
  'x-ima-request-id': requestId,
  'x-app-version': 'm27-self-fixture',
});

const call = async (
  path: string,
  owner: string,
  device: string,
  requestId: string,
  init: RequestInit = {},
): Promise<Response> =>
  (() => {
    const merged = new Headers(headers(owner, device, requestId));
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
    return SELF.fetch(`https://ima-app-integrity.test${path}`, { ...init, headers: merged });
  })();

const json = async (response: Response): Promise<Json> => {
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object response');
  }
  return value as Json;
};

const nonce = (body: Json) => v.parse(AppAttestNonceResponseSchema, body);

const searchBody = (requestId: string, threadId: string): Json => ({
  schemaVersion: 'v1',
  requestId,
  threadId,
  turnId: null,
  revision: 1,
  text: '静かな店',
  clientNow: '2026-09-10T12:00:00Z',
  location: {
    status: 'unavailable',
    lat: null,
    lng: null,
    accuracyMeters: null,
    precise: false,
    capturedAt: null,
  },
  prefs: {
    areaText: '恵比寿',
    budget: 'normal',
  },
  savedPlaceRefs: [],
  excludeCandidateIds: [],
  mode: 'search',
  idempotencyKey: `search-${requestId}`,
});

const assertionHeaders = (keyId: string, nonceValue: string): HeadersInit => ({
  'x-app-attest-keyid': keyId,
  'x-app-attest-nonce': nonceValue,
  'x-app-attest-assert': 'fixture-assertion',
});

describe('App Integrity bootstrap SELF composition', () => {
  it('uses the real DO stores through bootstrap and rejects binding violations/replay/revocation', async () => {
    const createId = `create-${crypto.randomUUID()}`;
    const created = await call('/v1/threads', OWNER_A, DEVICE_A, createId, {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: createId,
        idempotencyKey: `thread-${createId}`,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const threadId = createdBody.threadId;
    if (typeof threadId !== 'string') throw new Error('missing thread id');

    const nonceId = `nonce-${crypto.randomUUID()}`;
    const nonceResponse = await call('/v1/attest/nonce', OWNER_A, DEVICE_A, nonceId);
    expect(nonceResponse.status).toBe(200);
    const issued = nonce(await json(nonceResponse));
    const keyId = `key-${crypto.randomUUID()}`;
    const enrollId = `enroll-${crypto.randomUUID()}`;
    const enrolled = await call('/v1/attest/enroll', OWNER_A, DEVICE_A, enrollId, {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 'v1',
        requestId: enrollId,
        keyId,
        nonce: issued.nonce,
        attestation: 'fixture-attestation',
      }),
    });
    expect(enrolled.status).toBe(200);
    expect(v.parse(AppAttestEnrollResponseSchema, await json(enrolled)).registered).toBe(true);

    const ownerMismatchId = `owner-mismatch-${crypto.randomUUID()}`;
    const ownerMismatch = await call('/v1/attest/revoke', OWNER_B, DEVICE_B, ownerMismatchId, {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: 'v1', requestId: ownerMismatchId, keyId }),
    });
    expect(ownerMismatch.status).toBe(401);

    const requestId = `search-${crypto.randomUUID()}`;
    const protectedNonceId = `nonce-${crypto.randomUUID()}`;
    const protectedNonceResponse = await call(
      '/v1/attest/nonce',
      OWNER_A,
      DEVICE_A,
      protectedNonceId,
    );
    const protectedNonce = nonce(await json(protectedNonceResponse));
    const protectedHeaders = assertionHeaders(keyId, protectedNonce.nonce);
    const protectedResponse = await call('/v1/search', OWNER_A, DEVICE_A, requestId, {
      method: 'POST',
      headers: protectedHeaders,
      body: JSON.stringify(searchBody(requestId, threadId)),
    });
    // Provider execution is deliberately disabled in this auth fixture; 502 proves the
    // request passed App Integrity and reached the downstream runtime boundary.
    expect(protectedResponse.status).toBe(502);
    expect((await json(protectedResponse)).code).toBe('PROVIDER_UNAVAILABLE');

    const replay = await call('/v1/search', OWNER_A, DEVICE_A, requestId, {
      method: 'POST',
      headers: protectedHeaders,
      body: JSON.stringify(searchBody(requestId, threadId)),
    });
    expect(replay.status).toBe(401);

    const deviceNonceId = `nonce-${crypto.randomUUID()}`;
    const deviceNonceResponse = await call('/v1/attest/nonce', OWNER_A, DEVICE_A, deviceNonceId);
    const deviceNonce = nonce(await json(deviceNonceResponse));
    const wrongDeviceRequestId = `wrong-device-${crypto.randomUUID()}`;
    const wrongDevice = await call('/v1/search', OWNER_A, DEVICE_B, wrongDeviceRequestId, {
      method: 'POST',
      headers: assertionHeaders(keyId, deviceNonce.nonce),
      body: JSON.stringify(searchBody(wrongDeviceRequestId, threadId)),
    });
    expect(wrongDevice.status).toBe(401);

    const revokeId = `revoke-${crypto.randomUUID()}`;
    const revoked = await call('/v1/attest/revoke', OWNER_A, DEVICE_A, revokeId, {
      method: 'POST',
      body: JSON.stringify({ schemaVersion: 'v1', requestId: revokeId, keyId }),
    });
    expect(revoked.status).toBe(200);
    expect(v.parse(AppAttestRevokeResponseSchema, await json(revoked)).revoked).toBe(true);

    const revokedNonceId = `nonce-${crypto.randomUUID()}`;
    const revokedNonceResponse = await call('/v1/attest/nonce', OWNER_A, DEVICE_A, revokedNonceId);
    const revokedNonce = nonce(await json(revokedNonceResponse));
    const revokedRequestId = `revoked-${crypto.randomUUID()}`;
    const revokedRequest = await call('/v1/search', OWNER_A, DEVICE_A, revokedRequestId, {
      method: 'POST',
      headers: assertionHeaders(keyId, revokedNonce.nonce),
      body: JSON.stringify(searchBody(revokedRequestId, threadId)),
    });
    expect(revokedRequest.status).toBe(401);
  });
});
