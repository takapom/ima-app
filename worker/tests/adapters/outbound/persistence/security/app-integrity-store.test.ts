import { describe, expect, it } from 'vitest';
import { createAppIntegrityGate } from '@worker/composition/app-integrity-gate';
import {
  type AppIntegrityChallengeStore,
  type AppIntegrityKey,
  type AppIntegrityKeyStore,
  type AppIntegrityNonce,
  type AppIntegrityVerifier,
} from '@worker/application/ports/app-integrity';

const NOW = '2026-09-10T00:00:00.000Z';
const OWNER = 'owner-a';
const DEVICE = 'device-a';
const NONCE: AppIntegrityNonce = {
  ownerScopeRef: OWNER,
  deviceId: DEVICE,
  nonce: 'nonce-a',
  issuedAt: NOW,
  expiresAt: '2026-09-10T00:05:00.000Z',
};
const KEY: AppIntegrityKey = {
  ownerScopeRef: OWNER,
  deviceId: DEVICE,
  keyId: 'key-a',
  keyRef: 'opaque-key-ref',
  lastCounter: 0,
  revoked: false,
};

const baseChallenges = (): AppIntegrityChallengeStore => ({
  issue: () => Promise.resolve(true),
  consume: () => Promise.resolve(NONCE),
});

const baseKeys = (): AppIntegrityKeyStore => ({
  get: () => Promise.resolve(KEY),
  register: () => Promise.resolve('registered' as const),
  advanceCounter: () => Promise.resolve(true),
  revoke: () => Promise.resolve(true),
});

const verifier: AppIntegrityVerifier = {
  verifyAttestation: async () => {
    await Promise.resolve();
    return { verified: true, keyRef: KEY.keyRef };
  },
  verifyAssertion: async () => {
    await Promise.resolve();
    return { verified: true, counter: 1 };
  },
};

const authorize = async (challenges: AppIntegrityChallengeStore, keys: AppIntegrityKeyStore) =>
  createAppIntegrityGate({
    enforcement: 'required',
    environment: 'production',
    challenges,
    keys,
    verifier,
  }).authorize({
    route: 'search',
    ownerScopeRef: OWNER,
    deviceId: DEVICE,
    request: new Request('https://api.example.test/v1/search', {
      method: 'POST',
      headers: {
        'X-App-Attest-KeyId': KEY.keyId,
        'X-App-Attest-Nonce': NONCE.nonce,
        'X-App-Attest-Assert': 'assertion',
      },
    }),
    now: NOW,
    maxBodyBytes: 1024,
  });

describe('App Integrity store failure boundary', () => {
  it.each(['consume', 'get', 'advanceCounter'] as const)(
    'maps %s rejection to STORE_UNAVAILABLE',
    async (operation) => {
      const challenges = baseChallenges();
      const keys = baseKeys();
      let selectedChallenges = challenges;
      let selectedKeys = keys;
      if (operation === 'consume') {
        selectedChallenges = {
          ...challenges,
          consume: () => Promise.reject(new Error('raw challenge store secret')),
        };
      }
      if (operation === 'get') {
        selectedKeys = {
          ...keys,
          get: () => Promise.reject(new Error('raw key store secret')),
        };
      }
      if (operation === 'advanceCounter') {
        selectedKeys = {
          ...keys,
          advanceCounter: () => Promise.reject(new Error('raw counter store secret')),
        };
      }
      await expect(authorize(selectedChallenges, selectedKeys)).resolves.toEqual({
        allowed: false,
        code: 'STORE_UNAVAILABLE',
      });
    },
  );
});
