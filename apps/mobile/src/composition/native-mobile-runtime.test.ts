import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobileJourneyRuntime } from '@mobile/composition/mobile-runtime';
import type { JourneyApiControllerBinding } from '@mobile/journey/services/thread-session/journey-api-binding';
import type { JourneyApiController } from '@mobile/journey/services/thread-session/journey-controller-types';
import type {
  NativeSqliteAdapter,
  NativeSqliteAdapterOptions,
} from '@mobile/platform/sqlite/native';
import type { SqliteStore } from '@mobile/platform/sqlite/types';
import {
  NATIVE_CREDENTIALS_KEY_PREFIX,
  nativeCredentialScopeFor,
  nativeCredentialStorageKeyFor,
  type NativeCredentialAuthority,
  type NativeCredentialStoreClient,
} from '@mobile/platform/credentials/native-credentials';
import {
  createNativeMobileJourneyRuntime,
  nativeCredentialScopeMatchesRuntime,
  nativeSqliteStorageScopeFor,
} from '@mobile/composition/native-mobile-runtime';

const runtimeMock = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@mobile/composition/mobile-runtime', () => ({
  createMobileJourneyRuntime: runtimeMock.create,
  mobileJourneyRuntimeMessage: () => null,
}));

const credentials = {
  appToken: 'app-token',
  deviceId: 'device-1',
  ownerCredential: 'A'.repeat(43),
} as const;

const fixtureEnvironment = {
  EXPO_PUBLIC_ENVIRONMENT: 'dev',
  EXPO_PUBLIC_API_MODE: 'fixture',
  EXPO_PUBLIC_API_BASE_URL: 'http://localhost:8787/v1/',
  EXPO_PUBLIC_APP_VERSION: 'test',
} as const;

const authority: NativeCredentialAuthority = {
  environment: 'production',
  apiBaseUrl: 'https://api.example.test/v1/',
  storageScope: 'owner-scope-1',
};

const location = { acquire: vi.fn() };
const retention = null;

type MutableCredentialStoreClient = {
  -readonly [Key in keyof NativeCredentialStoreClient]: NativeCredentialStoreClient[Key];
};

const runtimeFor = (events: string[] = []): MobileJourneyRuntime => {
  const state = {
    mode: 'fixture',
    threadId: null,
    responseState: null,
    localSnapshot: null,
    activeTurnId: null,
    status: 'idle',
    error: null,
    lastRequestId: null,
  } as ReturnType<JourneyApiController['getState']>;
  const controller = {
    getState: () => state,
    subscribe: () => () => events.push('unsubscribe'),
    dispose: vi.fn(() => {
      events.push('controller');
    }),
  } as unknown as JourneyApiController;
  return {
    mode: 'fixture',
    reason: null,
    binding: { controller } as unknown as JourneyApiControllerBinding,
  };
};

const createClient = (raw: string | null): MutableCredentialStoreClient => {
  const values = new Map<string, string>();
  if (raw !== null) values.set('credential', raw);
  return {
    secureStoreOptions: vi.fn(() =>
      Promise.resolve({ keychainService: NATIVE_CREDENTIALS_KEY_PREFIX }),
    ),
    isAvailableAsync: vi.fn(() => Promise.resolve(true)),
    getItemAsync: vi.fn((key: string) =>
      Promise.resolve(values.get(key) ?? values.get('credential') ?? null),
    ),
    setItemAsync: vi.fn(() => Promise.resolve()),
    deleteItemAsync: vi.fn(() => Promise.resolve()),
  };
};

const seededClient = (): MutableCredentialStoreClient => {
  const scope = nativeCredentialScopeFor(authority);
  if (scope === null) throw new Error('test authority should be valid');
  const key = nativeCredentialStorageKeyFor(authority);
  if (key === null) throw new Error('test authority should have a key');
  return createClient(JSON.stringify({ schemaVersion: 'v1', authority: scope, credentials }));
};

const sqliteFor = (
  close: ReturnType<typeof vi.fn<() => void>> = vi.fn<() => void>(),
): {
  readonly factory: (options: NativeSqliteAdapterOptions) => NativeSqliteAdapter;
  readonly calls: NativeSqliteAdapterOptions[];
  readonly close: ReturnType<typeof vi.fn<() => void>>;
} => {
  const store = {} as unknown as SqliteStore;
  const calls: NativeSqliteAdapterOptions[] = [];
  const factory = (options: NativeSqliteAdapterOptions): NativeSqliteAdapter => {
    calls.push(options);
    return {
      storageScope: options.storageScope,
      initialize: vi.fn(() => store),
      close,
      getStore: vi.fn(() => store),
      isInitialized: vi.fn(() => true),
    };
  };
  return { factory, calls, close };
};

describe('native mobile runtime composition', () => {
  afterEach(() => {
    runtimeMock.create.mockReset();
    vi.useRealTimers();
  });

  it('does not start native SDK work when aborted before its operation microtask', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const client = seededClient();
    const controller = new AbortController();
    const initializing = createNativeMobileJourneyRuntime(
      {
        env: {
          EXPO_PUBLIC_ENVIRONMENT: 'production',
          EXPO_PUBLIC_API_MODE: 'live',
          EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
        },
        nativeAuthority: authority,
        secureStore: client,
        location,
      },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(initializing).resolves.toMatchObject({
      reason: 'native_initialization_aborted',
      binding: null,
    });
    expect(client.isAvailableAsync).not.toHaveBeenCalled();
    expect(client.getItemAsync).not.toHaveBeenCalled();
    expect(runtimeMock.create).not.toHaveBeenCalled();
  });

  it('loads SecureStore before opening SQLite and injects the same verified policy scope', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const client = seededClient();
    let release: ((raw: string | null) => void) | undefined;
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    client.getItemAsync = vi.fn(() => pending);
    const sqlite = sqliteFor();
    const initializing = createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: client,
      location,
      referenceRetentionFor: () => retention,
      sqlite: { adapterFactory: sqlite.factory },
    });

    await Promise.resolve();
    expect(sqlite.close).not.toHaveBeenCalled();
    expect(runtimeMock.create).not.toHaveBeenCalled();
    const scope = nativeCredentialScopeFor(authority);
    if (scope === null || release === undefined) throw new Error('test scope was not created');
    release(JSON.stringify({ schemaVersion: 'v1', authority: scope, credentials }));

    const ready = await initializing;
    expect(ready.storageScope).toBe(authority.storageScope);
    expect(ready.sqlite).not.toBeNull();
    expect(sqlite.calls[0]?.storageScope).toBe(nativeSqliteStorageScopeFor(scope));

    ready.dispose();
    ready.dispose();
    expect(sqlite.close).toHaveBeenCalledTimes(1);
  });

  it('does not publish SQLite when the native credential store is unavailable', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const client = seededClient();
    client.isAvailableAsync = vi.fn(() => Promise.resolve(false));
    const sqlite = sqliteFor();
    const ready = await createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: client,
      location,
      referenceRetentionFor: () => retention,
      sqlite: { adapterFactory: sqlite.factory },
    });

    expect(ready.reason).toBe('native_secure_store_unavailable');
    expect(ready.binding).toBeNull();
    expect(ready.sqlite).toBeNull();
    expect(sqlite.close).not.toHaveBeenCalled();
    expect(runtimeMock.create).not.toHaveBeenCalled();
  });

  it('rejects a scope that disagrees with the runtime before SecureStore I/O', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const client = seededClient();
    const ready = await createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'staging',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: client,
      location,
    });

    expect(ready.reason).toBe('native_scope_mismatch');
    expect(client.isAvailableAsync).not.toHaveBeenCalled();
    const scope = nativeCredentialScopeFor(authority);
    if (scope === null) throw new Error('test scope should be valid');
    expect(nativeCredentialScopeMatchesRuntime(scope, fixtureEnvironment)).toBe(false);
  });

  it('tears down local persistence before the controller and owned database', async () => {
    const events: string[] = [];
    runtimeMock.create.mockReturnValue(runtimeFor(events));
    const close = vi.fn<() => void>(() => {
      events.push('database');
    });
    const sqlite = sqliteFor(close);
    const ready = await createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: seededClient(),
      location,
      sqlite: { adapterFactory: sqlite.factory },
    });

    ready.dispose();
    ready.dispose();
    expect(events).toEqual(['unsubscribe', 'controller', 'database']);
  });

  it('bounds a pending SecureStore load and ignores its late completion', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const client = seededClient();
    let release: ((raw: string | null) => void) | undefined;
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    client.getItemAsync = vi.fn(() => pending);
    const sqlite = sqliteFor();
    vi.useFakeTimers();
    const initializing = createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: client,
      location,
      referenceRetentionFor: () => retention,
      sqlite: { adapterFactory: sqlite.factory },
      initTimeoutMs: 10,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await expect(initializing).resolves.toMatchObject({
      reason: 'native_init_timeout',
      binding: null,
    });
    release?.(null);
    await Promise.resolve();
    expect(sqlite.close).not.toHaveBeenCalled();
    expect(runtimeMock.create).not.toHaveBeenCalled();
  });

  it('uses one initialization deadline and closes a late SQLite resource safely', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const scope = nativeCredentialScopeFor(authority);
    if (scope === null) throw new Error('test scope should be valid');
    const databaseScope = nativeSqliteStorageScopeFor(scope);
    if (databaseScope === null) throw new Error('test database scope should be valid');
    const store = {} as unknown as SqliteStore;
    const close = vi.fn<() => void>(() => {
      throw new Error('late native close failed');
    });
    const adapter: NativeSqliteAdapter = {
      storageScope: databaseScope,
      initialize: vi.fn(() => store),
      close,
      getStore: vi.fn(() => store),
      isInitialized: vi.fn(() => true),
    };
    let release: ((value: NativeSqliteAdapter) => void) | undefined;
    const pendingAdapter = new Promise<NativeSqliteAdapter>((resolve) => {
      release = resolve;
    });
    const adapterFactory = vi.fn(() => pendingAdapter);
    vi.useFakeTimers();
    const client = seededClient();
    client.secureStoreOptions = vi.fn(() => {
      vi.advanceTimersByTime(7);
      return Promise.resolve({ keychainService: NATIVE_CREDENTIALS_KEY_PREFIX });
    });
    const initializing = createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: client,
      location,
      sqlite: { adapterFactory },
      initTimeoutMs: 10,
    });

    for (let attempt = 0; attempt < 64 && !adapterFactory.mock.calls.length; attempt += 1) {
      await Promise.resolve();
    }
    expect(adapterFactory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3);
    await expect(initializing).resolves.toMatchObject({ reason: 'native_init_timeout' });

    release?.(adapter);
    for (let attempt = 0; attempt < 16 && !close.mock.calls.length; attempt += 1) {
      await Promise.resolve();
    }
    expect(adapter.initialize).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps database names distinct across authority environments and origins', () => {
    const production = nativeCredentialScopeFor(authority);
    const staging = nativeCredentialScopeFor({
      ...authority,
      environment: 'staging',
      apiBaseUrl: 'https://api.example.test/v1/',
    });
    const otherOrigin = nativeCredentialScopeFor({
      ...authority,
      apiBaseUrl: 'https://other.example.test/v1/',
    });
    const normalUuid = nativeCredentialScopeFor({
      ...authority,
      storageScope: '9f3d2f58-18b4-4ed0-bc9a-8ef30c6074a1',
    });
    if (production === null || staging === null || otherOrigin === null || normalUuid === null) {
      throw new Error('test scopes should be valid');
    }
    expect(nativeSqliteStorageScopeFor(production)).not.toBe(nativeSqliteStorageScopeFor(staging));
    expect(nativeSqliteStorageScopeFor(production)).not.toBe(
      nativeSqliteStorageScopeFor(otherOrigin),
    );
    expect(nativeSqliteStorageScopeFor(production)).toMatch(/^ima-[A-Za-z0-9_-]+$/u);
    const normalUuidDatabaseScope = nativeSqliteStorageScopeFor(normalUuid);
    expect(normalUuidDatabaseScope).not.toBeNull();
    expect(normalUuidDatabaseScope?.length).toBeLessThanOrEqual(240);
  });

  it('does not surface native close failures during owned runtime disposal', async () => {
    runtimeMock.create.mockReturnValue(runtimeFor());
    const close = vi.fn<() => void>(() => {
      throw new Error('native close failed');
    });
    const sqlite = sqliteFor(close);
    const ready = await createNativeMobileJourneyRuntime({
      env: {
        EXPO_PUBLIC_ENVIRONMENT: 'production',
        EXPO_PUBLIC_API_MODE: 'live',
        EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
      },
      nativeAuthority: authority,
      secureStore: seededClient(),
      location,
      sqlite: { adapterFactory: sqlite.factory },
    });

    expect(() => ready.dispose()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
