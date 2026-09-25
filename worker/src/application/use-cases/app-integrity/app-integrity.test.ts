import { describe, expect, it, vi } from 'vitest';
import { createAppIntegrityApplication } from '@worker/application/use-cases/app-integrity/app-integrity';
import type { AppIntegrityNonce } from '@worker/application/ports/app-integrity';

const owner = { ownerScopeRef: 'owner-a', deviceId: 'device-a' };
const now = '2026-09-10T00:00:00.000Z';
const nonce: AppIntegrityNonce = {
  ...owner,
  nonce: 'challenge',
  issuedAt: now,
  expiresAt: '2026-09-10T00:05:00.000Z',
};
const fixture = () => {
  const order: string[] = [];
  let available = true;
  const keys = {
    get: vi.fn(() => {
      order.push('key');
      return Promise.resolve({
        ...owner,
        keyId: 'key',
        keyRef: 'ref',
        lastCounter: 1,
        revoked: false,
      });
    }),
    register: vi.fn(() => Promise.resolve('registered' as const)),
    advanceCounter: vi.fn(() => {
      order.push('counter');
      return Promise.resolve(true);
    }),
    revoke: vi.fn(() => Promise.resolve(true)),
  };
  const challenges = {
    issue: vi.fn(() => Promise.resolve(true)),
    consume: vi.fn(() => {
      order.push('consume');
      const result = available ? nonce : null;
      available = false;
      return Promise.resolve(result);
    }),
  };
  const verifier = {
    verifyAttestation: vi.fn(() => Promise.resolve({ verified: true as const, keyRef: 'ref' })),
    verifyAssertion: vi.fn(() => {
      order.push('verify');
      return Promise.resolve({ verified: true as const, counter: 2 });
    }),
  };
  const application = createAppIntegrityApplication({
    enforcement: 'required',
    environment: 'production',
    nonceTtlMs: 600_000,
    nonceGenerator: { generate: () => 'challenge' },
    keys,
    challenges,
    verifier,
  });
  const request = {
    ...owner,
    now,
    protected: true,
    hasAssertion: true,
    assertion: { keyId: 'key', nonce: 'challenge', assertion: 'proof' },
    proof: {
      hash: vi.fn(() => {
        order.push('hash');
        return Promise.resolve('digest');
      }),
    },
  };
  return { application, keys, challenges, verifier, request, order };
};

describe('App Integrity application without HTTP or crypto', () => {
  it('binds the generated challenge and caps its lifetime before storing it', async () => {
    const { application, challenges } = fixture();
    expect(await application.issueNonce({ ...owner, now })).toEqual(nonce);
    expect(challenges.issue).toHaveBeenCalledWith(nonce);
  });

  it('consumes once and checks the key before reading proof, then advances the verified counter', async () => {
    const { application, request, order, keys } = fixture();
    expect(await application.authorize(request)).toEqual({ allowed: true, requestHash: 'digest' });
    expect(order).toEqual(['consume', 'key', 'hash', 'verify', 'counter']);
    expect(keys.advanceCounter).toHaveBeenCalledWith({ ...owner, keyId: 'key', counter: 2 });
    expect(await application.authorize(request)).toEqual({
      allowed: false,
      code: 'CHALLENGE_INVALID',
    });
    expect(request.proof.hash).toHaveBeenCalledTimes(1);
  });

  it('does not verify or advance a counter after transport proof fails', async () => {
    const { application, request, verifier, keys } = fixture();
    request.proof.hash.mockRejectedValueOnce(new Error('bounded body read failed'));
    expect(await application.authorize(request)).toEqual({
      allowed: false,
      code: 'ASSERTION_INVALID',
    });
    expect(verifier.verifyAssertion).not.toHaveBeenCalled();
    expect(keys.advanceCounter).not.toHaveBeenCalled();
    expect(await application.authorize(request)).toEqual({
      allowed: false,
      code: 'CHALLENGE_INVALID',
    });
  });

  it('keeps a rejected atomic counter update denied', async () => {
    const { application, request, keys } = fixture();
    keys.advanceCounter.mockResolvedValueOnce(false);
    expect(await application.authorize(request)).toEqual({
      allowed: false,
      code: 'COUNTER_REPLAY',
    });
  });
});
