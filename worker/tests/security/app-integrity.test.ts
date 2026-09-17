import {
  AppAttestAssertionSchema,
  AppAttestEnrollRequestSchema,
  AppAttestNonceResponseSchema,
} from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  createAppIntegrityGate,
  resolveAppIntegrityPolicy,
  type AppIntegrityChallengeStore,
  type AppIntegrityKey,
  type AppIntegrityKeyStore,
  type AppIntegrityNonce,
  type AppIntegrityVerifier,
} from '@worker/security/app-integrity';
import { routeRequest } from '@worker/adapters/inbound/http/router';
import {
  makeHarness,
  makeRequest,
  requestId,
  searchInput,
} from '../adapters/inbound/http/router-fixtures';

const NOW = '2026-09-10T00:00:00.000Z';
const OWNER = 'owner-a';
const OTHER_OWNER = 'owner-b';
const DEVICE = 'device-a';
const OTHER_DEVICE = 'device-b';

type StoreFixture = {
  readonly challenges: AppIntegrityChallengeStore;
  readonly keys: AppIntegrityKeyStore;
  readonly challengeRecords: Map<string, AppIntegrityNonce>;
  readonly keyRecords: Map<string, AppIntegrityKey>;
};

const makeStore = (): StoreFixture => {
  const challengeRecords = new Map<string, AppIntegrityNonce>();
  const keyRecords = new Map<string, AppIntegrityKey>();
  const challenges: AppIntegrityChallengeStore = {
    issue: async (record) => {
      await Promise.resolve();
      const current = challengeRecords.get(record.nonce);
      if (current !== undefined && Date.parse(current.expiresAt) > Date.parse(record.issuedAt)) {
        return false;
      }
      challengeRecords.set(record.nonce, record);
      return true;
    },
    consume: async (input) => {
      await Promise.resolve();
      const record = challengeRecords.get(input.nonce);
      if (record === undefined) return null;
      if (Date.parse(record.expiresAt) <= Date.parse(input.now)) {
        challengeRecords.delete(input.nonce);
        return null;
      }
      if (record.ownerScopeRef !== input.ownerScopeRef || record.deviceId !== input.deviceId) {
        return null;
      }
      challengeRecords.delete(input.nonce);
      return record;
    },
  };
  const keys: AppIntegrityKeyStore = {
    get: async (keyId) => {
      await Promise.resolve();
      return keyRecords.get(keyId) ?? null;
    },
    register: async (key) => {
      await Promise.resolve();
      if (keyRecords.has(key.keyId)) return 'conflict';
      keyRecords.set(key.keyId, key);
      return 'registered';
    },
    advanceCounter: async (input) => {
      await Promise.resolve();
      const current = keyRecords.get(input.keyId);
      if (
        current === undefined ||
        current.revoked ||
        current.ownerScopeRef !== input.ownerScopeRef ||
        current.deviceId !== input.deviceId ||
        input.counter <= current.lastCounter
      ) {
        return false;
      }
      keyRecords.set(input.keyId, { ...current, lastCounter: input.counter });
      return true;
    },
    revoke: async (input) => {
      await Promise.resolve();
      const current = keyRecords.get(input.keyId);
      if (
        current === undefined ||
        current.ownerScopeRef !== input.ownerScopeRef ||
        current.deviceId !== input.deviceId
      ) {
        return false;
      }
      keyRecords.set(input.keyId, { ...current, revoked: true });
      return true;
    },
  };
  return { challenges, keys, challengeRecords, keyRecords };
};

const verifierFor = (counter: () => number, assertions: string[]): AppIntegrityVerifier => ({
  verifyAttestation: async ({ keyId, attestation, environment }) => {
    await Promise.resolve();
    assertions.push(`attestation:${keyId}:${attestation}:${environment}`);
    return { verified: true, keyRef: `key-ref:${keyId}` };
  },
  verifyAssertion: async ({ keyId, keyRef, requestHash, environment }) => {
    await Promise.resolve();
    assertions.push(`assertion:${keyId}:${keyRef}:${requestHash}:${environment}`);
    return { verified: true, counter: counter() };
  },
});

const issue = async (
  gate: ReturnType<typeof createAppIntegrityGate>,
  ownerScopeRef = OWNER,
  deviceId = DEVICE,
) => gate.issueNonce({ ownerScopeRef, deviceId, requestId, now: NOW });

const enroll = async (
  gate: ReturnType<typeof createAppIntegrityGate>,
  nonce: string,
  ownerScopeRef = OWNER,
  deviceId = DEVICE,
  keyId = 'key-a',
) =>
  gate.enroll({
    ownerScopeRef,
    deviceId,
    now: NOW,
    request: v.parse(AppAttestEnrollRequestSchema, {
      schemaVersion: 'v1',
      requestId,
      keyId,
      nonce,
      attestation: 'attestation-bytes',
    }),
  });

describe('App Integrity gate', () => {
  it('separates enforcement from Apple environment and fails closed on invalid values', () => {
    expect(resolveAppIntegrityPolicy({})).toEqual({
      enforcement: 'internal',
      environment: 'development',
    });
    expect(resolveAppIntegrityPolicy({ environment: 'production' })).toEqual({
      enforcement: 'required',
      environment: 'production',
    });
    expect(
      resolveAppIntegrityPolicy({
        deploymentEnvironment: 'production',
        environment: 'production',
        enforcement: 'disabled',
      }),
    ).toEqual({
      enforcement: 'required',
      environment: 'production',
    });
    expect(resolveAppIntegrityPolicy({ deploymentEnvironment: 'production' })).toEqual({
      enforcement: 'required',
      environment: 'unknown',
    });
    expect(
      resolveAppIntegrityPolicy({ deploymentEnvironment: 'staging', environment: 'development' }),
    ).toEqual({
      enforcement: 'required',
      environment: 'unknown',
    });
    expect(
      resolveAppIntegrityPolicy({ deploymentEnvironment: 'staging', enforcement: 'internal' }),
    ).toEqual({
      enforcement: 'required',
      environment: 'unknown',
    });
    expect(resolveAppIntegrityPolicy({ environment: 'unknown' }).enforcement).toBe('required');
    expect(resolveAppIntegrityPolicy({ enforcement: 'typo' }).enforcement).toBe('required');
    expect(
      resolveAppIntegrityPolicy({ deploymentEnvironment: 'qa', enforcement: 'disabled' }),
    ).toEqual({
      enforcement: 'required',
      environment: 'unknown',
    });
  });

  it('issues a five-minute nonce, binds it to owner/device, and consumes it once', async () => {
    const fixture = makeStore();
    const gate = createAppIntegrityGate({
      enforcement: 'required',
      environment: 'production',
      challenges: fixture.challenges,
      keys: fixture.keys,
      verifier: verifierFor(() => 1, []),
    });
    const response = await issue(gate);
    expect(v.safeParse(AppAttestNonceResponseSchema, response).success).toBe(true);
    expect(Date.parse(response.expiresAt) - Date.parse(NOW)).toBe(300_000);
    const nonce = response.nonce;
    expect(
      await fixture.challenges.consume({
        nonce,
        ownerScopeRef: OTHER_OWNER,
        deviceId: DEVICE,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      await fixture.challenges.consume({ nonce, ownerScopeRef: OWNER, deviceId: DEVICE, now: NOW }),
    ).not.toBeNull();
    expect(
      await fixture.challenges.consume({ nonce, ownerScopeRef: OWNER, deviceId: DEVICE, now: NOW }),
    ).toBeNull();
  });

  it('does not accept a second owner for an enrolled key', async () => {
    const fixture = makeStore();
    const gate = createAppIntegrityGate({
      enforcement: 'required',
      environment: 'production',
      challenges: fixture.challenges,
      keys: fixture.keys,
      verifier: verifierFor(() => 1, []),
    });
    const first = await issue(gate);
    expect(await enroll(gate, first.nonce)).toEqual({ registered: true });
    const second = await issue(gate, OTHER_OWNER, OTHER_DEVICE);
    expect(await enroll(gate, second.nonce, OTHER_OWNER, OTHER_DEVICE)).toEqual({
      registered: false,
      code: 'KEY_BINDING_MISMATCH',
    });
    const parsed = v.safeParse(AppAttestAssertionSchema, {
      keyId: 'key-a',
      nonce: first.nonce,
      assertion: 'assertion',
    });
    expect(parsed.success).toBe(true);
  });

  it('checks request hash, owner binding, monotonic counter, and revocation before access', async () => {
    const fixture = makeStore();
    let counter = 1;
    const seen: string[] = [];
    const gate = createAppIntegrityGate({
      enforcement: 'required',
      environment: 'production',
      challenges: fixture.challenges,
      keys: fixture.keys,
      verifier: verifierFor(() => counter, seen),
    });
    const enrolled = await issue(gate);
    expect(await enroll(gate, enrolled.nonce)).toEqual({ registered: true });

    const requestFor = (nonce: string, path = '/v1/search') =>
      new Request(`https://api.example.test${path}`, {
        method: 'POST',
        headers: {
          'X-App-Attest-KeyId': 'key-a',
          'X-App-Attest-Nonce': nonce,
          'X-App-Attest-Assert': 'assertion',
        },
        body: JSON.stringify({ requestId, text: path }),
      });
    const first = await issue(gate);
    expect(
      await gate.authorize({
        route: 'search',
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        request: requestFor(first.nonce),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toMatchObject({ allowed: true });
    expect(seen[1]).toContain('production');

    const replay = await issue(gate);
    expect(
      await gate.authorize({
        route: 'search',
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        request: requestFor(replay.nonce),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toEqual({ allowed: false, code: 'COUNTER_REPLAY' });

    counter = 2;
    const next = await issue(gate);
    expect(
      await gate.authorize({
        route: 'search',
        ownerScopeRef: OTHER_OWNER,
        deviceId: DEVICE,
        request: requestFor(next.nonce),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toEqual({ allowed: false, code: 'CHALLENGE_INVALID' });

    const validNext = await issue(gate);
    expect(
      await gate.authorize({
        route: 'search',
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        request: requestFor(validNext.nonce, '/v1/threads/thread-1'),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toMatchObject({ allowed: true });
    expect(seen[3]).not.toBe(seen[1]);
    expect(await gate.revoke({ keyId: 'key-a', ownerScopeRef: OWNER, deviceId: DEVICE })).toBe(
      true,
    );
    const revoked = await issue(gate);
    expect(
      await gate.authorize({
        route: 'photos',
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        request: requestFor(revoked.nonce, '/v1/photos/photo-1'),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toEqual({ allowed: false, code: 'KEY_REVOKED' });
  });

  it('never turns an unavailable Apple verifier into success and bounds request hashing', async () => {
    const missing = createAppIntegrityGate({ enforcement: 'required', environment: 'production' });
    const noHeaders = await missing.authorize({
      route: 'search',
      ownerScopeRef: OWNER,
      deviceId: DEVICE,
      request: new Request('https://api.example.test/v1/search', { method: 'POST' }),
      now: NOW,
      maxBodyBytes: 32 * 1024,
    });
    expect(noHeaders).toEqual({ allowed: false, code: 'ASSERTION_MISSING' });
    const internal = createAppIntegrityGate({
      enforcement: 'internal',
      environment: 'development',
    });
    expect(
      await internal.authorize({
        route: 'search',
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        request: new Request('https://api.example.test/v1/search', { method: 'POST' }),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toEqual({ allowed: true });

    const fixture = makeStore();
    let verifierCalls = 0;
    const gate = createAppIntegrityGate({
      enforcement: 'required',
      environment: 'production',
      challenges: fixture.challenges,
      keys: fixture.keys,
      verifier: {
        verifyAttestation: async () => {
          await Promise.resolve();
          return { verified: true, keyRef: 'key-ref' };
        },
        verifyAssertion: async () => {
          await Promise.resolve();
          verifierCalls += 1;
          return { verified: true, counter: 1 };
        },
      },
    });
    const nonce = await issue(gate);
    expect(await enroll(gate, nonce.nonce)).toEqual({ registered: true });
    const bodyNonce = await issue(gate);
    const body = 'x'.repeat(32 * 1024 + 1);
    expect(
      await gate.authorize({
        route: 'turn',
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        request: new Request('https://api.example.test/v1/threads/t/turns', {
          method: 'POST',
          headers: {
            'X-App-Attest-KeyId': 'key-a',
            'X-App-Attest-Nonce': bodyNonce.nonce,
            'X-App-Attest-Assert': 'assertion',
          },
          body,
        }),
        now: NOW,
        maxBodyBytes: 32 * 1024,
      }),
    ).toEqual({ allowed: false, code: 'ASSERTION_INVALID' });
    expect(verifierCalls).toBe(0);

    const unknownEnvironment = createAppIntegrityGate({
      enforcement: 'required',
      environment: 'unknown',
      challenges: fixture.challenges,
      keys: fixture.keys,
      verifier: verifierFor(() => 1, []),
    });
    await expect(issue(unknownEnvironment)).rejects.toThrow('APP_ATTEST_NONCE_UNAVAILABLE');
    const unknownNonce: AppIntegrityNonce = {
      ownerScopeRef: OWNER,
      deviceId: DEVICE,
      nonce: 'unknown-environment-nonce',
      issuedAt: NOW,
      expiresAt: '2026-09-10T00:05:00.000Z',
    };
    expect(await fixture.challenges.issue(unknownNonce)).toBe(true);
    expect(
      await unknownEnvironment.enroll({
        ownerScopeRef: OWNER,
        deviceId: DEVICE,
        now: NOW,
        request: v.parse(AppAttestEnrollRequestSchema, {
          schemaVersion: 'v1',
          requestId,
          keyId: 'unknown-key',
          nonce: unknownNonce.nonce,
          attestation: 'attestation-bytes',
        }),
      }),
    ).toEqual({ registered: false, code: 'VERIFIER_UNAVAILABLE' });
  });

  it('enforces required integrity at the existing authenticated HTTP entry', async () => {
    const harness = makeHarness();
    const gate = createAppIntegrityGate({ enforcement: 'required', environment: 'production' });
    const response = await routeRequest(
      makeRequest('/v1/search', { method: 'POST', json: searchInput }),
      { ...harness.config, appIntegrity: gate },
    );
    expect(response.status).toBe(401);
    expect(harness.calls.rate).toBe(1);
    expect(harness.calls.application).toBe(0);
  });
});
