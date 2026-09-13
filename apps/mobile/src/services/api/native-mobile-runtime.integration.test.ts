import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocationService } from '../location/types';
import {
  createNativeSqliteAdapter,
  type NativeSqliteDatabase,
  type NativeSqliteDriver,
} from '../sqlite/native';
import type { LocalSavedEntryId, SqliteValue } from '../sqlite/types';
import {
  NATIVE_CREDENTIALS_KEY_PREFIX,
  nativeCredentialScopeFor,
  nativeCredentialStorageKeyFor,
  type NativeCredentialAuthority,
  type NativeCredentialStoreClient,
} from './native-credentials';
import {
  createNativeMobileJourneyRuntime,
  type NativeMobileRuntimeOptions,
} from './native-mobile-runtime';
import type { ApiFetch } from './api';
import {
  createThreadResponse,
  json,
  requestBodyFor,
  searchRequestFor,
  searchResponse,
  stringField,
} from './mobile-runtime-storage-fixtures';

vi.mock('expo-sqlite', () => ({
  openDatabaseSync: () => {
    throw new Error('the Expo driver is not used by this Node SQLite integration');
  },
}));

const authority: NativeCredentialAuthority = {
  environment: 'production',
  apiBaseUrl: 'https://api.example.test/v1/',
  storageScope: '9f3d2f58-18b4-4ed0-bc9a-8ef30c6074a1',
};

const environment = {
  EXPO_PUBLIC_ENVIRONMENT: 'production',
  EXPO_PUBLIC_API_MODE: 'live',
  EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test/v1/',
  EXPO_PUBLIC_APP_VERSION: 'integration-test',
} as const;

const credentials = {
  appToken: 'integration-app-token',
  deviceId: 'integration-device',
  ownerCredential: 'A'.repeat(43),
} as const;

const retentionPolicy = () => ({
  retentionDecision: 'allow' as const,
  retentionMode: 'identifier_indefinite_owner_scoped' as const,
  sessionExpiresAt: '2026-09-10T14:00:00.000Z',
  freshUntil: '2026-09-10T13:30:00.000Z',
  displayUntil: '2026-09-10T14:00:00.000Z',
  retentionUntil: '2026-09-10T14:00:00.000Z',
  deletionScheduledAt: '2026-09-10T14:00:00.000Z',
  attribution: null,
  restoreMode: 'reference_only' as const,
  policyStatus: 'available' as const,
  displayPolicyStatus: 'available' as const,
});

const unavailableLocation: LocationService = {
  acquire: () =>
    Promise.resolve({
      status: 'unavailable' as const,
      lat: null,
      lng: null,
      accuracyMeters: null,
      precise: false,
      capturedAt: null,
    }),
};

const nativeDatabaseFor = (database: DatabaseSync): NativeSqliteDatabase => ({
  closeSync: () => database.close(),
  execSync: (source) => database.exec(source),
  prepareSync: (source) => {
    const statement = database.prepare(source);
    const isQuery = /^\s*(SELECT|PRAGMA)\b/i.test(source);
    return {
      executeSync: <T>(...values: SqliteValue[]) => {
        if (!isQuery) {
          statement.run(...values);
          return {
            getFirstSync: (): T | null => null,
            getAllSync: (): T[] => [],
          };
        }
        const rows = statement.all(...values).map((row) => row as Record<string, unknown>);
        return {
          getFirstSync: (): T | null => (rows[0] as T | undefined) ?? null,
          getAllSync: (): T[] => rows as T[],
        };
      },
      finalizeSync: () => undefined,
    };
  },
  withTransactionSync: (task) => {
    database.exec('BEGIN');
    try {
      task();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  },
});

const secureStoreFor = (): NativeCredentialStoreClient => {
  const scope = nativeCredentialScopeFor(authority);
  const key = nativeCredentialStorageKeyFor(authority);
  if (scope === null || key === null) throw new Error('integration authority should be valid');
  const raw = JSON.stringify({ schemaVersion: 'v1', authority: scope, credentials });
  return {
    secureStoreOptions: () => Promise.resolve({ keychainService: NATIVE_CREDENTIALS_KEY_PREFIX }),
    isAvailableAsync: () => Promise.resolve(true),
    getItemAsync: (requestedKey) => Promise.resolve(requestedKey === key ? raw : null),
    setItemAsync: () => Promise.resolve(),
    deleteItemAsync: () => Promise.resolve(),
  };
};

const fetchFor = (): ApiFetch => (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const body = requestBodyFor(init);
  if (url.endsWith('/v1/threads')) {
    return Promise.resolve(json(createThreadResponse(stringField(body, 'requestId')), 201));
  }
  if (url.endsWith('/v1/search')) {
    return Promise.resolve(json(searchResponse(stringField(body, 'requestId')), 200));
  }
  return Promise.resolve(new Response(null, { status: 404 }));
};

type DatabaseHarness = {
  readonly directory: string;
  readonly databases: DatabaseSync[];
  readonly driver: NativeSqliteDriver;
};

const databaseHarness = (): DatabaseHarness => {
  const directory = mkdtempSync(join(tmpdir(), 'ima-native-runtime-'));
  const path = join(directory, 'journey.sqlite');
  const databases: DatabaseSync[] = [];
  return {
    directory,
    databases,
    driver: {
      openDatabaseSync: () => {
        const database = new DatabaseSync(path);
        databases.push(database);
        return nativeDatabaseFor(database);
      },
    },
  };
};

describe('native mobile runtime SQLite integration', () => {
  let harness: DatabaseHarness | undefined;

  afterEach(() => {
    for (const database of harness?.databases ?? []) {
      try {
        database.close();
      } catch {
        // The runtime owns and normally closes each connection.
      }
    }
    if (harness !== undefined) rmSync(harness.directory, { recursive: true, force: true });
    harness = undefined;
  });

  const optionsFor = (now: string): NativeMobileRuntimeOptions => {
    const currentHarness = harness;
    if (currentHarness === undefined) throw new Error('database harness is not initialized');
    return {
      env: environment,
      nativeAuthority: authority,
      secureStore: secureStoreFor(),
      location: unavailableLocation,
      fetchImpl: fetchFor(),
      now: () => now,
      referenceRetentionFor: retentionPolicy,
      sqlite: {
        adapterFactory: (adapterOptions) =>
          createNativeSqliteAdapter({ ...adapterOptions, driver: currentHarness.driver }),
        nextLocalSavedEntryId: () => 'saved-integration' as LocalSavedEntryId,
      },
    };
  };

  it('persists a real response snapshot, restores it in a new runtime, and rejects expiry', async () => {
    harness = databaseHarness();
    const first = await createNativeMobileJourneyRuntime(optionsFor('2026-09-10T12:00:00.000Z'));
    if (first.binding === null || first.sqlite === null) {
      throw new Error(`first native runtime unavailable: ${first.reason ?? 'no binding/sqlite'}`);
    }
    await expect(
      first.binding.controller.createThread(first.binding.requests.createThread()),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      first.binding.controller.search(searchRequestFor(first.binding)),
    ).resolves.toMatchObject({ ok: true });
    expect(first.sqlite.readSnapshot('thread-runtime')).toMatchObject({
      threadId: 'thread-runtime',
      revision: 2,
      response: null,
      restoreMode: 'reference_only',
    });
    first.dispose();

    const restored = await createNativeMobileJourneyRuntime(optionsFor('2026-09-10T12:30:00.000Z'));
    if (restored.binding === null || restored.sqlite === null) {
      throw new Error('restored native runtime should expose controller and SQLite');
    }
    await expect(restored.binding.controller.restoreLocal('thread-runtime')).resolves.toMatchObject(
      {
        status: 'restored',
        snapshot: { threadId: 'thread-runtime', revision: 2 },
      },
    );
    restored.dispose();

    const expired = await createNativeMobileJourneyRuntime(optionsFor('2026-09-10T14:00:00.000Z'));
    if (expired.binding === null) throw new Error('expired runtime should expose controller');
    await expect(expired.binding.controller.restoreLocal('thread-runtime')).resolves.toEqual({
      status: 'empty',
    });
    expired.dispose();
  });
});
