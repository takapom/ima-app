import { AppAttestEnrollRequestSchema } from '@ima/contracts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { deriveOwnerScopeRef } from '../../src/http/auth';
import { routeRequest } from '../../src/http/router';
import {
  createAppIntegrityGate,
  type AppIntegrityGate,
  type AppIntegrityKeyStore,
  type AppIntegrityChallengeStore,
  type AppIntegrityNonce,
  type AppIntegrityKey,
} from '../../src/security/app-integrity';
import { makeHarness, makeRequest, requestId, searchInput, turnInput } from './router-fixtures';

const NOW = '2026-09-10T00:00:00.000Z';

const deferred = <T>() => {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  if (resolve === undefined) throw new Error('Promise executor did not initialize');
  return { promise, resolve };
};

const makeStore = (): {
  readonly challenges: AppIntegrityChallengeStore;
  readonly keys: AppIntegrityKeyStore;
} => {
  const challengesByNonce = new Map<string, AppIntegrityNonce>();
  const keysById = new Map<string, AppIntegrityKey>();
  return {
    challenges: {
      issue: async (record) => {
        await Promise.resolve();
        if (challengesByNonce.has(record.nonce)) return false;
        challengesByNonce.set(record.nonce, record);
        return true;
      },
      consume: async ({ nonce, ownerScopeRef, deviceId, now }) => {
        await Promise.resolve();
        const record = challengesByNonce.get(nonce);
        if (
          record === undefined ||
          record.ownerScopeRef !== ownerScopeRef ||
          record.deviceId !== deviceId ||
          Date.parse(record.expiresAt) <= Date.parse(now)
        ) {
          return null;
        }
        challengesByNonce.delete(nonce);
        return record;
      },
    },
    keys: {
      get: async (keyId) => {
        await Promise.resolve();
        return keysById.get(keyId) ?? null;
      },
      register: async (key) => {
        await Promise.resolve();
        if (keysById.has(key.keyId)) return 'conflict';
        keysById.set(key.keyId, key);
        return 'registered';
      },
      advanceCounter: async ({ keyId, ownerScopeRef, deviceId, counter }) => {
        await Promise.resolve();
        const current = keysById.get(keyId);
        if (
          current === undefined ||
          current.revoked ||
          current.ownerScopeRef !== ownerScopeRef ||
          current.deviceId !== deviceId ||
          counter <= current.lastCounter
        ) {
          return false;
        }
        keysById.set(keyId, { ...current, lastCounter: counter });
        return true;
      },
      revoke: async ({ keyId, ownerScopeRef, deviceId }) => {
        await Promise.resolve();
        const current = keysById.get(keyId);
        if (
          current === undefined ||
          current.ownerScopeRef !== ownerScopeRef ||
          current.deviceId !== deviceId
        ) {
          return false;
        }
        keysById.set(keyId, { ...current, revoked: true });
        return true;
      },
    },
  };
};

describe('App Integrity HTTP boundary', () => {
  it('hashes the exact validated HTTP body before search dispatch', async () => {
    const fixture = makeStore();
    const ownerScopeRef = await deriveOwnerScopeRef('A'.repeat(43));
    if (ownerScopeRef === null) throw new Error('expected owner scope fixture');
    let expectedHash: string | null = null;
    let counter = 0;
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
        verifyAssertion: async ({ requestHash }) => {
          await Promise.resolve();
          if (expectedHash === null) expectedHash = requestHash;
          counter += 1;
          return { verified: requestHash === expectedHash, counter };
        },
      },
    });
    const enrolled = await gate.issueNonce({
      ownerScopeRef,
      deviceId: 'device-1',
      requestId,
      now: NOW,
    });
    expect(
      await gate.enroll({
        ownerScopeRef,
        deviceId: 'device-1',
        now: NOW,
        request: v.parse(AppAttestEnrollRequestSchema, {
          schemaVersion: 'v1',
          requestId,
          keyId: 'key-a',
          nonce: enrolled.nonce,
          attestation: 'attestation-bytes',
        }),
      }),
    ).toEqual({ registered: true });

    const assertionHeaders = async (): Promise<HeadersInit> => {
      const nonce = await gate.issueNonce({
        ownerScopeRef,
        deviceId: 'device-1',
        requestId,
        now: NOW,
      });
      return {
        'X-App-Attest-KeyId': 'key-a',
        'X-App-Attest-Nonce': nonce.nonce,
        'X-App-Attest-Assert': 'assertion',
      };
    };
    const harness = makeHarness({ serverNow: NOW });
    const first = await routeRequest(
      makeRequest('/v1/search', {
        method: 'POST',
        json: searchInput,
        headers: await assertionHeaders(),
      }),
      { ...harness.config, appIntegrity: gate },
    );
    expect(first.status).toBe(200);
    expect(expectedHash).not.toBeNull();

    const whitespace = await routeRequest(
      makeRequest('/v1/search', {
        method: 'POST',
        body: JSON.stringify(searchInput, null, 2),
        headers: { ...(await assertionHeaders()), 'content-type': 'application/json' },
      }),
      { ...harness.config, appIntegrity: gate },
    );
    expect(whitespace.status).toBe(401);

    const modified = await routeRequest(
      makeRequest('/v1/search', {
        method: 'POST',
        json: { ...searchInput, text: '本文を一文字変更' },
        headers: await assertionHeaders(),
      }),
      { ...harness.config, appIntegrity: gate },
    );
    expect(modified.status).toBe(401);
    expect(harness.calls.application).toBe(1);

    expectedHash = null;
    const turn = await routeRequest(
      makeRequest('/v1/threads/thread-1/turns', {
        method: 'POST',
        json: turnInput,
        headers: await assertionHeaders(),
      }),
      { ...harness.config, appIntegrity: gate },
    );
    expect(turn.status).toBe(200);
    expect(harness.calls.application).toBe(2);
  });

  it('uses the gate-admission clock after delayed ownership and maps store errors to fixed responses', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const ownership = {
      authorize: async () => {
        entered.resolve();
        await release.promise;
        return { allowed: true as const };
      },
    };
    const seenNow: string[] = [];
    const gate: AppIntegrityGate = {
      enforcement: 'required',
      environment: 'production',
      issueNonce: () => Promise.reject(new Error('unused')),
      enroll: () => Promise.resolve({ registered: false, code: 'STORE_UNAVAILABLE' as const }),
      revoke: () => Promise.resolve(false),
      authorize: ({ now }) => {
        seenNow.push(now);
        return Promise.resolve(
          now === '2026-09-10T00:05:00.000Z'
            ? { allowed: false, code: 'CHALLENGE_INVALID' as const }
            : { allowed: true as const },
        );
      },
    };
    const harness = makeHarness({ serverNow: NOW });
    let clockCalls = 0;
    const responsePromise = routeRequest(
      makeRequest('/v1/search', { method: 'POST', json: searchInput }),
      {
        ...harness.config,
        appIntegrity: gate,
        ownership,
        now: () => {
          clockCalls += 1;
          return clockCalls === 1 ? NOW : '2026-09-10T00:05:00.000Z';
        },
      },
    );
    await entered.promise;
    release.resolve();
    expect((await responsePromise).status).toBe(401);
    expect(seenNow).toEqual(['2026-09-10T00:05:00.000Z']);
    expect(harness.calls.application).toBe(0);

    const rawErrorGate: AppIntegrityGate = {
      ...gate,
      authorize: () => Promise.reject(new Error('raw-store-secret')),
    };
    const rawErrorResponse = await routeRequest(
      makeRequest('/v1/search', { method: 'POST', json: searchInput }),
      { ...harness.config, appIntegrity: rawErrorGate },
    );
    expect(rawErrorResponse.status).toBe(401);
    expect(await rawErrorResponse.text()).not.toContain('raw-store-secret');
  });

  it('returns cancellation when the gate resolves after the request aborts', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const gate: AppIntegrityGate = {
      enforcement: 'required',
      environment: 'production',
      issueNonce: () => Promise.reject(new Error('unused')),
      enroll: () => Promise.resolve({ registered: false, code: 'STORE_UNAVAILABLE' as const }),
      revoke: () => Promise.resolve(false),
      authorize: () => {
        entered.resolve();
        return release.promise.then(() => ({ allowed: true as const }));
      },
    };
    const controller = new AbortController();
    const harness = makeHarness({ serverNow: NOW });
    const responsePromise = routeRequest(
      makeRequest('/v1/search', {
        method: 'POST',
        json: searchInput,
        signal: controller.signal,
      }),
      { ...harness.config, appIntegrity: gate },
    );
    await entered.promise;
    controller.abort();
    release.resolve();
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(harness.calls.application).toBe(0);
  });
});
