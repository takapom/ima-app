import { describe, expect, it } from 'vitest';
import { createPersonalConnection } from '@mobile/platform/credentials/personal-connection';
import {
  createSecureStoreCredentialStore,
  type NativeCredentialStoreClient,
} from '@mobile/platform/credentials/native-credentials';

const target = { environment: 'staging', apiBaseUrl: 'https://staging.example.invalid' } as const;
const token = 'a1'.repeat(32);

const fixture = () => {
  const records = new Map<string, string>();
  const secureStore: NativeCredentialStoreClient = {
    secureStoreOptions: () => Promise.resolve({}),
    isAvailableAsync: () => Promise.resolve(true),
    getItemAsync: (key) => Promise.resolve(records.get(key) ?? null),
    setItemAsync: (key, value) => {
      records.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
  };
  let sequence = 0;
  const dependencies = {
    secureStore,
    randomId: () =>
      Promise.resolve(`00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`),
    randomBytes: () => Promise.resolve(new Uint8Array(32).fill(9)),
  };
  return { records, dependencies, service: createPersonalConnection(target, dependencies) };
};

describe('personal connection provisioning', () => {
  it('requires first-run setup, then restores the same credential scope after restart', async () => {
    const { service, dependencies } = fixture();
    expect(await service.load()).toEqual({ status: 'missing' });
    const result = await service.save(token);
    expect(result.status).toBe('ready');
    expect(await createPersonalConnection(target, dependencies).load()).toEqual(result);
    if (result.status !== 'ready') throw new Error('expected ready');
    const loaded = await createSecureStoreCredentialStore({
      authority: result.authority,
      secureStore: dependencies.secureStore,
    }).load();
    expect(loaded.status).toBe('available');
    if (loaded.status !== 'available') throw new Error('expected credentials');
    expect(loaded.credentials.appToken).toBe(token);
    expect(loaded.credentials.ownerCredential).toHaveLength(43);
    expect(result).not.toHaveProperty('credentials');
  });

  it('rotates only the app token and preserves owner, device and SQLite scope', async () => {
    const { service, dependencies } = fixture();
    const first = await service.save(token);
    if (first.status !== 'ready') throw new Error('expected ready');
    const store = createSecureStoreCredentialStore({
      authority: first.authority,
      secureStore: dependencies.secureStore,
    });
    const before = await store.load();
    expect(await service.save('b2'.repeat(32))).toEqual(first);
    const after = await store.load();
    if (before.status !== 'available' || after.status !== 'available')
      throw new Error('expected credentials');
    expect(after.credentials).toEqual({ ...before.credentials, appToken: 'b2'.repeat(32) });
  });

  it('allocates a new storage namespace when the credential record is gone', async () => {
    const { service, dependencies } = fixture();
    const first = await service.save(token);
    if (first.status !== 'ready') throw new Error('expected ready');
    await createSecureStoreCredentialStore({
      authority: first.authority,
      secureStore: dependencies.secureStore,
    }).delete();
    expect(await service.load()).toEqual({ status: 'missing' });
    const second = await service.save(token);
    if (second.status !== 'ready') throw new Error('expected ready');
    expect(second.authority.storageScope).not.toBe(first.authority.storageScope);
  });

  it('does not expose credentials to a different API origin', async () => {
    const { service, dependencies } = fixture();
    await service.save(token);
    expect(
      await createPersonalConnection(
        { ...target, apiBaseUrl: 'https://other.example.invalid' },
        dependencies,
      ).load(),
    ).toEqual({ status: 'missing' });
  });

  it('rejects a pasted command, placeholder, or malformed token without writing', async () => {
    const { service, records } = fixture();
    for (const value of [
      '',
      'replace-me',
      'bunx wrangler secret put APP_TOKEN',
      'x'.repeat(64),
      `${token}\n`,
    ]) {
      expect(await service.save(value)).toEqual({ status: 'invalid_token' });
    }
    expect(records.size).toBe(0);
  });

  it('reports SecureStore failure instead of claiming a saved connection', async () => {
    const { dependencies } = fixture();
    const service = createPersonalConnection(target, {
      ...dependencies,
      secureStore: {
        ...dependencies.secureStore,
        setItemAsync: () => Promise.reject(new Error('SDK failure')),
      },
    });
    expect(await service.save(token)).toEqual({ status: 'unavailable' });
    expect(await service.load()).toEqual({ status: 'missing' });
  });

  it('fails closed for a corrupt scope pointer and invalid random bytes', async () => {
    const { service, dependencies, records } = fixture();
    await service.save(token);
    for (const [key, value] of records) {
      if (!value.startsWith('{')) records.set(key, '../other-user');
    }
    expect(await service.load()).toEqual({ status: 'invalid' });
    expect(await service.save(token)).toEqual({ status: 'invalid' });
    const fresh = fixture();
    expect(
      await createPersonalConnection(target, {
        ...fresh.dependencies,
        randomBytes: () => Promise.resolve(new Uint8Array(1)),
      }).save(token),
    ).toEqual({ status: 'unavailable' });
    expect(fresh.records.size).toBe(0);
    expect(
      await createPersonalConnection(
        { ...target, apiBaseUrl: 'http://localhost:8787' },
        dependencies,
      ).save(token),
    ).toEqual({ status: 'invalid' });
  });
});
