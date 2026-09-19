import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { AppAttestEnrollRequestSchema } from '@ima/contracts';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  createAppIntegrityGate,
  type AppIntegrityKey,
  type AppIntegrityNonce,
} from '@worker/security/app-integrity';
import {
  createDurableAppIntegrityStores,
  type AppIntegrityDO,
  type AppIntegrityNamespace,
} from '@worker/adapters/out/persistence/security/app-integrity-do';

const OWNER_A = `${'A'.repeat(42)}E`;
const OWNER_B = `${'B'.repeat(42)}E`;
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';
const environment = 'production' as const;

type TestEnv = typeof env & { readonly APP_INTEGRITY: AppIntegrityNamespace };

const hasAppIntegrityBinding = (value: typeof env): value is TestEnv =>
  typeof value === 'object' && value !== null && 'APP_INTEGRITY' in value;

const testEnv = (value: typeof env): TestEnv => {
  if (!hasAppIntegrityBinding(value)) throw new Error('M27_APP_INTEGRITY_BINDING_MISSING');
  return value;
};

const ownerNonceStub = (ownerScopeRef: string): DurableObjectStub<AppIntegrityDO> =>
  testEnv(env).APP_INTEGRITY.getByName(`nonce:${ownerScopeRef}:${crypto.randomUUID()}`);

const keyStub = (keyId: string): DurableObjectStub<AppIntegrityDO> =>
  testEnv(env).APP_INTEGRITY.getByName(`key:${keyId}`);

const nonce = (
  ownerScopeRef: string,
  deviceId: string,
  suffix: string,
  options: { readonly issuedAtMs?: number; readonly expiresAtMs?: number } = {},
): AppIntegrityNonce => {
  const now = Date.now();
  return {
    ownerScopeRef,
    deviceId,
    nonce: `nonce-${suffix}`,
    issuedAt: new Date(options.issuedAtMs ?? now - 1_000).toISOString(),
    expiresAt: new Date(options.expiresAtMs ?? now + 4 * 60 * 1_000).toISOString(),
  };
};

const key = (ownerScopeRef: string, deviceId: string, keyId: string): AppIntegrityKey => ({
  ownerScopeRef,
  deviceId,
  keyId,
  keyRef: `verifier-ref-${keyId}`,
  lastCounter: 0,
  revoked: false,
});

describe('M27 App Integrity Durable Object', () => {
  it('consumes a nonce once and enforces owner, device, and environment binding', async () => {
    const stub = ownerNonceStub(OWNER_A);
    const record = nonce(OWNER_A, DEVICE_A, crypto.randomUUID());
    await expect(stub.issueNonce(record, environment)).resolves.toBe(true);
    await expect(stub.issueNonce(record, environment)).resolves.toBe(false);
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_B,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_B,
        nonce: record.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date().toISOString(),
        environment: 'development',
      }),
    ).resolves.toBeNull();
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toEqual(record);
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    const concurrentRecord = nonce(OWNER_A, DEVICE_A, crypto.randomUUID());
    await expect(stub.issueNonce(concurrentRecord, environment)).resolves.toBe(true);
    const consumed = await Promise.all([
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: concurrentRecord.nonce,
        now: new Date().toISOString(),
        environment,
      }),
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: concurrentRecord.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ]);
    expect(consumed.filter((value) => value !== null)).toHaveLength(1);
    const persistedRecord = nonce(OWNER_A, DEVICE_A, crypto.randomUUID());
    await expect(stub.issueNonce(persistedRecord, environment)).resolves.toBe(true);
    await evictDurableObject(stub);
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: concurrentRecord.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: persistedRecord.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toEqual(persistedRecord);
    await evictDurableObject(stub);
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: persistedRecord.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
  });

  it('rejects expired or overlong nonces and removes expired rows on alarm', async () => {
    const stub = ownerNonceStub(OWNER_A);
    const now = Date.now();
    await expect(
      stub.issueNonce(
        nonce(OWNER_A, DEVICE_A, `future-${crypto.randomUUID()}`, {
          issuedAtMs: now + 1_000,
          expiresAtMs: now + 2 * 60 * 1_000,
        }),
        environment,
      ),
    ).resolves.toBe(false);
    await expect(
      stub.issueNonce(
        nonce(OWNER_A, DEVICE_A, `expired-${crypto.randomUUID()}`, {
          issuedAtMs: now - 10_000,
          expiresAtMs: now - 1,
        }),
        environment,
      ),
    ).resolves.toBe(false);
    await expect(
      stub.issueNonce(
        nonce(OWNER_A, DEVICE_A, `long-${crypto.randomUUID()}`, {
          expiresAtMs: now + 6 * 60 * 1_000,
        }),
        environment,
      ),
    ).resolves.toBe(false);
    const record = nonce(OWNER_A, DEVICE_A, crypto.randomUUID());
    await expect(stub.issueNonce(record, environment)).resolves.toBe(true);
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date(now + 10_000).toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE app_integrity_nonce SET expires_at_ms = ? WHERE nonce = ?',
        Date.now() - 1,
        record.nonce,
      );
    });
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date(now - 60_000).toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    await runInDurableObject(stub, async (instance) => instance.alarm());
    await expect(
      stub.consumeNonce({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        nonce: record.nonce,
        now: new Date().toISOString(),
        environment,
      }),
    ).resolves.toBeNull();
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBe(null);
  });

  it('keeps key IDs globally immutable and atomically advances counters', async () => {
    const sharedKeyId = `shared-${crypto.randomUUID()}`;
    const stub = keyStub(sharedKeyId);
    const ownerKey = key(OWNER_A, DEVICE_A, sharedKeyId);
    const otherOwnerKey = key(OWNER_B, DEVICE_B, sharedKeyId);
    const registrations = await Promise.all([
      stub.registerKey(ownerKey, environment),
      stub.registerKey(otherOwnerKey, environment),
    ]);
    expect(registrations.filter((result) => result === 'registered')).toHaveLength(1);
    expect(registrations.filter((result) => result === 'conflict')).toHaveLength(1);
    const winner = registrations[0] === 'registered' ? ownerKey : otherOwnerKey;
    await expect(
      stub.getKey({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        environment,
      }),
    ).resolves.toEqual(winner);
    await expect(
      stub.getKey({
        ownerScopeRef: winner.ownerScopeRef === OWNER_A ? OWNER_B : OWNER_A,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        environment,
      }),
    ).resolves.toBeNull();
    const counters = await Promise.all([
      stub.advanceCounter({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        counter: 1,
        environment,
      }),
      stub.advanceCounter({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        counter: 1,
        environment,
      }),
    ]);
    expect(counters.filter(Boolean)).toHaveLength(1);
    await expect(
      stub.advanceCounter({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        counter: 1,
        environment,
      }),
    ).resolves.toBe(false);
    await expect(
      stub.revokeKey({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        environment: 'development',
      }),
    ).resolves.toBe(false);
    await expect(
      stub.revokeKey({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        environment,
      }),
    ).resolves.toBe(true);
    await expect(
      stub.advanceCounter({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        counter: 2,
        environment,
      }),
    ).resolves.toBe(false);
    await evictDurableObject(stub);
    await expect(
      stub.getKey({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        environment,
      }),
    ).resolves.toMatchObject({ lastCounter: 1, revoked: true });
    await expect(stub.registerKey(winner, environment)).resolves.toBe('conflict');
    await expect(
      stub.getKey({
        ownerScopeRef: winner.ownerScopeRef,
        deviceId: winner.deviceId,
        keyId: sharedKeyId,
        environment,
      }),
    ).resolves.toMatchObject({ lastCounter: 1, revoked: true });
  });

  it('persists key state through a newly acquired stub and adapts existing gate ports', async () => {
    const keyId = `adapter-${crypto.randomUUID()}`;
    const stores = createDurableAppIntegrityStores(testEnv(env).APP_INTEGRITY, environment);
    const gate = createAppIntegrityGate({
      enforcement: 'required',
      environment,
      ...stores,
      verifier: {
        verifyAttestation: () =>
          Promise.resolve({ verified: true as const, keyRef: `ref-${keyId}` }),
        verifyAssertion: () => Promise.resolve({ verified: true as const, counter: 1 }),
      },
    });
    const issued = await gate.issueNonce({
      ownerScopeRef: OWNER_A,
      deviceId: DEVICE_A,
      requestId: 'request-adapter',
      now: new Date().toISOString(),
    });
    await expect(
      gate.enroll({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        now: new Date().toISOString(),
        request: v.parse(AppAttestEnrollRequestSchema, {
          schemaVersion: 'v1',
          requestId: 'request-adapter',
          keyId,
          nonce: issued.nonce,
          attestation: 'opaque-attestation',
        }),
      }),
    ).resolves.toEqual({ registered: true });
    const reopened = keyStub(keyId);
    await expect(
      reopened.getKey({
        ownerScopeRef: OWNER_A,
        deviceId: DEVICE_A,
        keyId,
        environment,
      }),
    ).resolves.toMatchObject({ keyId, lastCounter: 0, revoked: false });
    const assertionNonce = await gate.issueNonce({
      ownerScopeRef: OWNER_A,
      deviceId: DEVICE_A,
      requestId: 'request-adapter',
      now: new Date().toISOString(),
    });
    const authorized = await gate.authorize({
      route: 'search',
      ownerScopeRef: OWNER_A,
      deviceId: DEVICE_A,
      request: new Request('https://api.example.test/v1/search', {
        method: 'POST',
        body: '{}',
        headers: {
          'X-App-Attest-KeyId': keyId,
          'X-App-Attest-Nonce': assertionNonce.nonce,
          'X-App-Attest-Assert': 'opaque-assertion',
        },
      }),
      now: new Date().toISOString(),
      maxBodyBytes: 1024,
    });
    expect(authorized).toEqual(expect.objectContaining({ allowed: true }));
  });
});
