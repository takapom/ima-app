import { describe, expect, it, vi } from 'vitest';
import type { ApiCredentialProvider, ApiCredentials } from '@mobile/services/api/api';
import {
  createSecureStoreCredentialStore,
  NATIVE_CREDENTIALS_KEY_PREFIX,
  nativeCredentialScopeFor,
  nativeCredentialStorageKeyFor,
  type NativeCredentialAuthority,
  type NativeCredentialProvider,
  type NativeCredentialStoreClient,
} from '@mobile/services/runtime/native-credentials';

const authority: NativeCredentialAuthority = {
  environment: 'production',
  apiBaseUrl: 'https://api.example.test/v1/',
  storageScope: 'owner-scope-1',
};

const credentials: ApiCredentials = {
  appToken: 'app-token',
  deviceId: 'device-1',
  ownerCredential: 'A'.repeat(43),
};

const TEST_DEVICE_ONLY_ACCESSIBILITY = 901;

const createFakeStore = (initial: string | null = null) => {
  const values = new Map<string, string>();
  if (initial !== null) values.set('initial', initial);
  let available = true;
  const calls = {
    get: 0,
    set: 0,
    delete: 0,
    getKeys: [] as string[],
    setKeys: [] as string[],
    deleteKeys: [] as string[],
  };
  const client: NativeCredentialStoreClient = {
    secureStoreOptions: vi.fn(() =>
      Promise.resolve({
        keychainService: NATIVE_CREDENTIALS_KEY_PREFIX,
        keychainAccessible: TEST_DEVICE_ONLY_ACCESSIBILITY,
      }),
    ),
    isAvailableAsync: vi.fn(() => Promise.resolve(available)),
    getItemAsync: vi.fn((key: string) => {
      calls.get += 1;
      calls.getKeys.push(key);
      return Promise.resolve(values.get(key) ?? null);
    }),
    setItemAsync: vi.fn((key: string, next: string) => {
      calls.set += 1;
      calls.setKeys.push(key);
      values.set(key, next);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      calls.delete += 1;
      calls.deleteKeys.push(key);
      values.delete(key);
      return Promise.resolve();
    }),
  };
  return {
    client,
    calls,
    valueFor(key: string): string | null {
      return values.get(key) ?? null;
    },
    put(key: string, value: string): void {
      values.set(key, value);
    },
    setAvailable(next: boolean): void {
      available = next;
    },
  };
};

describe('native SecureStore credentials', () => {
  it('stores one authority-bound record and exposes a contract-compatible provider', async () => {
    const fake = createFakeStore();
    const store = createSecureStoreCredentialStore({ authority, secureStore: fake.client });
    const provider: NativeCredentialProvider = store.provider;
    const contractProvider: ApiCredentialProvider = provider;
    expect(typeof contractProvider).toBe('function');

    await expect(store.save(credentials)).resolves.toMatchObject({
      status: 'saved',
      scope: {
        environment: 'production',
        apiOrigin: 'https://api.example.test',
        storageScope: 'owner-scope-1',
      },
    });
    expect(fake.calls.set).toBe(1);
    expect(fake.client.secureStoreOptions).toHaveBeenCalledWith();
    expect(fake.client.setItemAsync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        keychainService: NATIVE_CREDENTIALS_KEY_PREFIX,
        keychainAccessible: TEST_DEVICE_ONLY_ACCESSIBILITY,
      }),
    );
    const storageKey = nativeCredentialStorageKeyFor(authority);
    expect(storageKey).not.toBeNull();
    expect(fake.valueFor(storageKey ?? '')).not.toBeNull();
    const stored = JSON.parse(fake.valueFor(storageKey ?? '') ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['authority', 'credentials', 'schemaVersion']);
    expect(stored.credentials).toEqual(credentials);

    await expect(store.load()).resolves.toMatchObject({
      status: 'available',
      credentials,
    });
    await expect(provider()).resolves.toEqual(credentials);
    expect(fake.calls.get).toBe(2);
  });

  it('returns a non-secret scope and canonicalizes only the authority origin', () => {
    expect(nativeCredentialScopeFor(authority)).toEqual({
      environment: 'production',
      apiOrigin: 'https://api.example.test',
      storageScope: 'owner-scope-1',
    });
    expect(JSON.stringify(nativeCredentialScopeFor(authority))).not.toContain(
      credentials.ownerCredential,
    );
  });

  it.each([
    ['empty app token', { ...credentials, appToken: '' }],
    ['invalid device id', { ...credentials, deviceId: 'device id' }],
    ['invalid owner credential', { ...credentials, ownerCredential: 'short' }],
  ])('rejects %s before SecureStore I/O', async (_label, invalid) => {
    const fake = createFakeStore();
    const store = createSecureStoreCredentialStore({ authority, secureStore: fake.client });

    await expect(store.save(invalid)).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid_credentials',
    });
    expect(fake.calls.set).toBe(0);
  });

  it.each([
    ['unknown environment', { ...authority, environment: 'qa' }],
    ['production HTTP', { ...authority, apiBaseUrl: 'http://api.example.test' }],
    [
      'embedded URL credentials',
      { ...authority, apiBaseUrl: 'https://user:pass@api.example.test' },
    ],
    ['invalid storage scope', { ...authority, storageScope: 'owner scope' }],
  ])('rejects %s without reading or writing credentials', async (_label, invalid) => {
    const fake = createFakeStore();
    const store = createSecureStoreCredentialStore({
      authority: invalid as unknown as NativeCredentialAuthority,
      secureStore: fake.client,
    });

    expect(store.scope).toBeNull();
    await expect(store.load()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'invalid_authority',
    });
    await expect(store.save(credentials)).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid_authority',
    });
    expect(fake.calls.get).toBe(0);
    expect(fake.calls.set).toBe(0);
  });

  it('fails closed when the SecureStore API is unavailable and never falls back to env values', async () => {
    const fake = createFakeStore();
    fake.setAvailable(false);
    const store = createSecureStoreCredentialStore({ authority, secureStore: fake.client });

    await expect(store.load()).resolves.toEqual({
      status: 'unavailable',
      reason: 'sdk_unavailable',
    });
    await expect(store.save(credentials)).resolves.toEqual({
      status: 'unavailable',
      reason: 'sdk_unavailable',
    });
    await expect(store.delete()).resolves.toEqual({
      status: 'unavailable',
      reason: 'sdk_unavailable',
    });
    await expect(store.provider()).rejects.toMatchObject({ code: 'sdk_unavailable' });
    expect(fake.calls.get).toBe(0);
    expect(fake.calls.set).toBe(0);
    expect(fake.calls.delete).toBe(0);
  });

  it('normalizes SDK errors without exposing the rejected value', async () => {
    const secret = 'native-secret-error';
    const client: NativeCredentialStoreClient = {
      secureStoreOptions: vi.fn(() =>
        Promise.resolve({
          keychainService: NATIVE_CREDENTIALS_KEY_PREFIX,
          keychainAccessible: TEST_DEVICE_ONLY_ACCESSIBILITY,
        }),
      ),
      isAvailableAsync: vi.fn(() => Promise.resolve(true)),
      getItemAsync: vi.fn(() => Promise.reject(new Error(secret))),
      setItemAsync: vi.fn(() => Promise.resolve()),
      deleteItemAsync: vi.fn(() => Promise.resolve()),
    };
    const store = createSecureStoreCredentialStore({ authority, secureStore: client });

    const result = await store.load();
    expect(result).toEqual({ status: 'unavailable', reason: 'sdk_error' });
    await expect(store.provider()).rejects.toMatchObject({
      code: 'sdk_error',
      message: 'native API credentials are unavailable',
    });
    await expect(store.provider()).rejects.not.toThrow(secret);
  });

  it('rejects malformed records and records from another API authority', async () => {
    const malformed = createFakeStore();
    malformed.put(
      nativeCredentialStorageKeyFor(authority) ?? '',
      '{"schemaVersion":"v1","credentials":{}}',
    );
    const malformedStore = createSecureStoreCredentialStore({
      authority,
      secureStore: malformed.client,
    });
    await expect(malformedStore.load()).resolves.toEqual({
      status: 'invalid',
      reason: 'invalid_record',
    });

    const fake = createFakeStore();
    const first = createSecureStoreCredentialStore({ authority, secureStore: fake.client });
    await expect(first.save(credentials)).resolves.toMatchObject({ status: 'saved' });
    const firstKey = nativeCredentialStorageKeyFor(authority);
    const wrongRecord = JSON.parse(fake.valueFor(firstKey ?? '') ?? '{}') as Record<
      string,
      unknown
    >;
    wrongRecord.authority = {
      environment: 'production',
      apiOrigin: 'https://other.example.test',
      storageScope: 'owner-scope-1',
    };
    fake.put(firstKey ?? '', JSON.stringify(wrongRecord));
    await expect(first.load()).resolves.toEqual({
      status: 'invalid',
      reason: 'authority_mismatch',
    });
    await expect(first.provider()).rejects.toMatchObject({ code: 'authority_mismatch' });
  });

  it('uses independent non-secret keys so one authority cannot delete another record', async () => {
    const fake = createFakeStore();
    const store = createSecureStoreCredentialStore({ authority, secureStore: fake.client });
    const otherAuthority = { ...authority, storageScope: 'other-scope' } as const;
    const other = createSecureStoreCredentialStore({
      authority: otherAuthority,
      secureStore: fake.client,
    });
    await store.save(credentials);
    await other.save(credentials);
    const firstKey = nativeCredentialStorageKeyFor(authority);
    const otherKey = nativeCredentialStorageKeyFor(otherAuthority);
    expect(firstKey).not.toBe(otherKey);
    await expect(store.delete()).resolves.toEqual({ status: 'deleted' });
    await expect(other.load()).resolves.toMatchObject({ status: 'available' });
    expect(fake.calls.delete).toBe(1);
    expect(fake.calls.deleteKeys).toEqual([firstKey]);
  });
});
