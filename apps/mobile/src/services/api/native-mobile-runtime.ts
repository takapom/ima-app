import type { PublicCard, RetentionMetadata } from '@ima/contracts';
import { createRuntimeId } from '../runtime-id';
import type { LocalSavedEntryId } from '../saved-place-types';
import type { LocationService, LocationServiceOptions } from '../location/types';
import type {
  NativeSqliteAdapter,
  NativeSqliteAdapterOptions,
  NativeSqliteDriver,
} from '../sqlite/native';
import type { SqliteStore } from '../sqlite/types';
import {
  createSecureStoreCredentialStore,
  nativeCredentialScopeFor,
  type NativeCredentialAuthority,
  type NativeCredentialLoadResult,
  type NativeCredentialProvider,
  type NativeCredentialScope,
  type NativeCredentialStoreClient,
} from './native-credentials';
import {
  createMobileJourneyRuntime,
  mobileJourneyRuntimeMessage,
  type MobileJourneyRuntime,
  type MobileJourneyRuntimeOptions,
  type MobileJourneyRuntimeReason,
  type MobileRuntimeEnvironment,
  type MobileJourneySavedReferenceOptions,
} from './mobile-runtime';
import type { ApiCredentialProvider } from './api';
import { waitFor, type WaitResult } from './native-runtime-deferred';
import {
  createLocalSessionPersistence,
  createSqliteJourneyLocalRestore,
  type LocalSessionPersistence,
} from './local-session-persistence';

export const NATIVE_RUNTIME_INIT_TIMEOUT_MS = 5_000;
const NATIVE_RUNTIME_TIMEOUT_CAP_MS = 15_000;

/** Native SQLite options that keep the verified storage scope outside host input. */
export type NativeMobileSqliteOptions = {
  /** The host may defer SDK/module work behind this async boundary. */
  readonly adapterFactory?: (
    options: NativeSqliteAdapterOptions,
  ) => NativeSqliteAdapter | Promise<NativeSqliteAdapter>;
  readonly driver?: NativeSqliteDriver;
  readonly databaseOptions?: NativeSqliteAdapterOptions['databaseOptions'];
  readonly directory?: string;
  readonly nextLocalSavedEntryId?: () => LocalSavedEntryId;
};

export type NativeMobileRuntimeOptions = Omit<
  MobileJourneyRuntimeOptions,
  'credentials' | 'savedReference' | 'location'
> & {
  /** Native credentials are enabled only when this authority is explicitly supplied. */
  readonly nativeAuthority?: NativeCredentialAuthority;
  readonly secureStore?: NativeCredentialStoreClient;
  readonly credentials?: ApiCredentialProvider;
  /** A host policy is required before a saved-reference adapter is published. */
  readonly referenceRetentionFor?: (candidate: PublicCard) => RetentionMetadata | null;
  /** Existing host injection is preserved for fixture/unit composition. */
  readonly savedReference?: MobileJourneySavedReferenceOptions;
  readonly location?: LocationService | null;
  readonly locationOptions?: LocationServiceOptions;
  readonly locationLoader?: (
    options: LocationServiceOptions,
  ) => LocationService | Promise<LocationService>;
  /** Omit to use the default owner-scoped native SQLite adapter. */
  readonly sqlite?: NativeMobileSqliteOptions | null;
  readonly initTimeoutMs?: number;
};

export type NativeMobileRuntimeReason =
  | MobileJourneyRuntimeReason
  | 'native_authority_invalid'
  | 'native_scope_mismatch'
  | 'native_credentials_missing'
  | 'native_credentials_invalid'
  | 'native_secure_store_unavailable'
  | 'native_sqlite_unavailable'
  | 'native_runtime_failed'
  | 'native_init_timeout'
  | 'native_initialization_aborted';

export type NativeMobileJourneyRuntime = Omit<MobileJourneyRuntime, 'reason'> & {
  readonly reason: NativeMobileRuntimeReason | null;
  /** The verified scope is metadata only; it never contains credentials. */
  readonly storageScope: string | null;
  /** Null when native SQLite was not requested or was not published. */
  readonly sqlite: SqliteStore | null;
  /** Disposes only resources owned by this composition. */
  readonly dispose: () => void;
};

export type NativeMobileRuntimeInitializeOptions = {
  readonly signal?: AbortSignal;
};

const unavailable = (reason: NativeMobileRuntimeReason): NativeMobileJourneyRuntime => ({
  mode: 'unconfigured',
  binding: null,
  reason,
  storageScope: null,
  sqlite: null,
  dispose: () => undefined,
});

const valueFor = (env: MobileRuntimeEnvironment, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const expoEnvironment = (): MobileRuntimeEnvironment => ({
  // Keep direct references so Expo can substitute public variables at bundle time.
  EXPO_PUBLIC_ENVIRONMENT: process.env.EXPO_PUBLIC_ENVIRONMENT,
  EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
  EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
  EXPO_PUBLIC_APP_VERSION: process.env.EXPO_PUBLIC_APP_VERSION,
  EXPO_PUBLIC_FIXTURE_APP_TOKEN: process.env.EXPO_PUBLIC_FIXTURE_APP_TOKEN,
  EXPO_PUBLIC_FIXTURE_DEVICE_ID: process.env.EXPO_PUBLIC_FIXTURE_DEVICE_ID,
  EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL: process.env.EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL,
});

const timeoutFor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return NATIVE_RUNTIME_INIT_TIMEOUT_MS;
  }
  return Math.min(value, NATIVE_RUNTIME_TIMEOUT_CAP_MS);
};

const scopeMatchesEnvironment = (
  scope: NativeCredentialScope,
  env: MobileRuntimeEnvironment,
): boolean => {
  const environment = valueFor(env, 'EXPO_PUBLIC_ENVIRONMENT');
  const mode = valueFor(env, 'EXPO_PUBLIC_API_MODE');
  const baseUrl = valueFor(env, 'EXPO_PUBLIC_API_BASE_URL');
  if (environment === undefined || baseUrl === undefined) return false;
  if (scope.environment !== environment) return false;
  if (mode === 'fixture' && scope.environment !== 'dev') return false;
  if (mode !== 'fixture' && mode !== 'live') return false;
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return false;
    }
    return parsed.origin === scope.apiOrigin && (mode !== 'live' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
};

export const nativeCredentialScopeMatchesRuntime = (
  scope: NativeCredentialScope,
  env: MobileRuntimeEnvironment,
): boolean => scopeMatchesEnvironment(scope, env);

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SQLITE_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/u;

const base64UrlFor = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 0x3f];
  }
  return encoded;
};

/** Names the database with the full verified authority without storing secrets. */
export const nativeSqliteStorageScopeFor = (scope: NativeCredentialScope): string | null => {
  const encoded = base64UrlFor(
    JSON.stringify([scope.environment, scope.apiOrigin, scope.storageScope]),
  );
  const databaseScope = `ima-${encoded}`;
  return databaseScope.length <= 240 && SQLITE_SCOPE_PATTERN.test(databaseScope)
    ? databaseScope
    : null;
};

const reasonForCredentialLoad = (result: NativeCredentialLoadResult): NativeMobileRuntimeReason => {
  if (result.status === 'missing') return 'native_credentials_missing';
  if (result.status === 'invalid') return 'native_credentials_invalid';
  if (result.status === 'unavailable') return 'native_secure_store_unavailable';
  return 'native_secure_store_unavailable';
};

const locationFor = async (
  options: NativeMobileRuntimeOptions,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitResult<LocationService | null>> => {
  if (options.location !== undefined) return { status: 'fulfilled', value: options.location };
  const loader =
    options.locationLoader ??
    (async (locationOptions: LocationServiceOptions): Promise<LocationService> => {
      const module = await import('../location/expo-location-adapter');
      return module.createExpoLocationService(locationOptions);
    });
  return waitFor(() => loader(options.locationOptions ?? {}), timeoutMs, signal);
};

type SqliteLoadResult = {
  readonly adapter: NativeSqliteAdapter;
  readonly store: SqliteStore;
};

type SqliteLoadOutcome = SqliteLoadResult | { readonly status: 'timeout' | 'aborted' };

const closeAdapter = (adapter: NativeSqliteAdapter): void => {
  try {
    adapter.close();
  } catch {
    // Closing an already-invalid native handle is still a released resource.
  }
};

const sqliteFor = async (
  options: NativeMobileRuntimeOptions,
  scope: NativeCredentialScope,
  now: () => string,
  deadlineAt: number,
  signal: AbortSignal | undefined,
): Promise<WaitResult<SqliteLoadOutcome | null>> => {
  if (options.sqlite === null) return { status: 'fulfilled', value: null };
  const databaseScope = nativeSqliteStorageScopeFor(scope);
  if (databaseScope === null) return { status: 'rejected' };
  const sqliteOptions = options.sqlite ?? {};
  const load = async (): Promise<SqliteLoadOutcome> => {
    const adapterOptions: NativeSqliteAdapterOptions = {
      storageScope: databaseScope,
      clock: { now },
      nextLocalSavedEntryId:
        sqliteOptions.nextLocalSavedEntryId ??
        (() => createRuntimeId('saved') as LocalSavedEntryId),
      ...(sqliteOptions.driver === undefined ? {} : { driver: sqliteOptions.driver }),
      ...(sqliteOptions.databaseOptions === undefined
        ? {}
        : { databaseOptions: sqliteOptions.databaseOptions }),
      ...(sqliteOptions.directory === undefined ? {} : { directory: sqliteOptions.directory }),
    };
    const adapter =
      sqliteOptions.adapterFactory === undefined
        ? (await import('../sqlite/native')).createNativeSqliteAdapter(adapterOptions)
        : await sqliteOptions.adapterFactory(adapterOptions);
    // A module/SDK can resolve after the shared initialization deadline. Close
    // that handle without running migrations or exposing a store.
    if (signal?.aborted) {
      closeAdapter(adapter);
      return { status: 'aborted' };
    }
    if (Date.now() >= deadlineAt) {
      closeAdapter(adapter);
      return { status: 'timeout' };
    }
    try {
      return { adapter, store: adapter.initialize() };
    } catch (error) {
      closeAdapter(adapter);
      throw error;
    }
  };
  const result = await waitFor(load, Math.max(0, deadlineAt - Date.now()), signal, (late) => {
    if ('adapter' in late) closeAdapter(late.adapter);
  });
  if (result.status !== 'fulfilled' || result.value === null) return result;
  if ('status' in result.value) return result;
  if (result.value.adapter.storageScope !== databaseScope) {
    closeAdapter(result.value.adapter);
    return { status: 'rejected' };
  }
  return result;
};

const disposeResources = (
  runtime: MobileJourneyRuntime | null,
  persistence: LocalSessionPersistence | null,
  adapter: NativeSqliteAdapter | null,
): void => {
  try {
    try {
      persistence?.dispose();
    } catch {
      // Persistence is auxiliary; controller teardown must still run.
    }
    try {
      runtime?.binding?.controller.dispose();
    } catch {
      // A cleanup boundary must not turn unmount into an application error.
    }
  } finally {
    if (adapter !== null) closeAdapter(adapter);
  }
};

const runtimeOptionsFor = (
  options: NativeMobileRuntimeOptions,
  env: MobileRuntimeEnvironment,
  credentials: ApiCredentialProvider | undefined,
  location: LocationService | null,
  savedReference: MobileJourneySavedReferenceOptions | undefined,
  localRestore: MobileJourneyRuntimeOptions['localRestore'],
  now: () => string,
): MobileJourneyRuntimeOptions => ({
  env,
  ...(credentials === undefined ? {} : { credentials }),
  ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  now,
  ...(options.requestIdFactory === undefined ? {} : { requestIdFactory: options.requestIdFactory }),
  ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  ...(location === null ? {} : { location }),
  ...(savedReference === undefined ? {} : { savedReference }),
  ...(localRestore === undefined ? {} : { localRestore }),
});

const readyRuntimeFor = (
  runtime: MobileJourneyRuntime,
  scope: NativeCredentialScope | null,
  sqlite: SqliteLoadResult | null,
  persistence: LocalSessionPersistence | null,
): NativeMobileJourneyRuntime => {
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    disposeResources(runtime, persistence, sqlite?.adapter ?? null);
  };
  return {
    ...runtime,
    storageScope: scope?.storageScope ?? null,
    sqlite: sqlite?.store ?? null,
    dispose,
  };
};

/** Loads native SDKs at this async boundary, then composes the sync runtime. */
export const createNativeMobileJourneyRuntime = async (
  options: NativeMobileRuntimeOptions = {},
  initializeOptions: NativeMobileRuntimeInitializeOptions = {},
): Promise<NativeMobileJourneyRuntime> => {
  const signal = initializeOptions.signal;
  const env = options.env ?? expoEnvironment();
  const timeoutMs = timeoutFor(options.initTimeoutMs);
  const deadlineAt = Date.now() + timeoutMs;
  const remainingTimeout = (): number => Math.max(0, deadlineAt - Date.now());
  const now = options.now ?? (() => new Date().toISOString());
  const authority = options.nativeAuthority;
  let scope: NativeCredentialScope | null = null;
  let credentialProvider: NativeCredentialProvider | undefined;
  let sqlite: SqliteLoadResult | null = null;
  let runtime: MobileJourneyRuntime | null = null;
  let persistence: LocalSessionPersistence | null = null;

  if (signal?.aborted) return unavailable('native_initialization_aborted');
  if (authority !== undefined) {
    scope = nativeCredentialScopeFor(authority);
    if (scope === null) return unavailable('native_authority_invalid');
    if (!scopeMatchesEnvironment(scope, env)) return unavailable('native_scope_mismatch');
    const credentialStore = createSecureStoreCredentialStore({
      authority,
      ...(options.secureStore === undefined ? {} : { secureStore: options.secureStore }),
    });
    const loaded = await waitFor(() => credentialStore.load(), remainingTimeout(), signal);
    if (loaded.status === 'aborted') return unavailable('native_initialization_aborted');
    if (loaded.status === 'timeout') return unavailable('native_init_timeout');
    if (loaded.status !== 'fulfilled') return unavailable('native_secure_store_unavailable');
    if (loaded.value.status !== 'available')
      return unavailable(reasonForCredentialLoad(loaded.value));
    if (!scopeMatchesEnvironment(loaded.value.scope, env)) {
      return unavailable('native_scope_mismatch');
    }
    credentialProvider = credentialStore.provider;
  }

  const locationResult = await locationFor(options, remainingTimeout(), signal);
  if (locationResult.status === 'aborted') return unavailable('native_initialization_aborted');
  if (locationResult.status === 'timeout') return unavailable('native_init_timeout');
  const location = locationResult.status === 'fulfilled' ? locationResult.value : null;

  const policy = options.referenceRetentionFor ?? options.savedReference?.referenceRetentionFor;
  if (authority !== undefined && options.sqlite !== null) {
    if (scope === null) return unavailable('native_authority_invalid');
    const sqliteResult = await sqliteFor(options, scope, now, deadlineAt, signal);
    if (sqliteResult.status === 'aborted') return unavailable('native_initialization_aborted');
    if (sqliteResult.status === 'timeout') return unavailable('native_init_timeout');
    if (sqliteResult.status !== 'fulfilled') return unavailable('native_sqlite_unavailable');
    const sqliteValue = sqliteResult.value;
    if (sqliteValue === null) {
      sqlite = null;
    } else if ('status' in sqliteValue) {
      return unavailable(
        sqliteValue.status === 'aborted' ? 'native_initialization_aborted' : 'native_init_timeout',
      );
    } else {
      sqlite = sqliteValue;
    }
  }

  if (signal?.aborted) {
    if (sqlite !== null) closeAdapter(sqlite.adapter);
    return unavailable('native_initialization_aborted');
  }
  const localRestore =
    sqlite?.store === undefined
      ? options.localRestore
      : createSqliteJourneyLocalRestore(sqlite.store);
  const savedReference =
    authority !== undefined && sqlite?.store !== undefined && policy !== undefined
      ? { sqlite: sqlite.store, referenceRetentionFor: policy }
      : authority === undefined
        ? options.savedReference
        : undefined;
  const runtimeOptions = runtimeOptionsFor(
    options,
    env,
    credentialProvider ?? options.credentials,
    location,
    savedReference,
    localRestore,
    now,
  );
  try {
    runtime = createMobileJourneyRuntime(runtimeOptions);
  } catch {
    disposeResources(null, null, sqlite?.adapter ?? null);
    return unavailable('native_runtime_failed');
  }
  if (runtime.binding === null || runtime.reason !== null) {
    disposeResources(runtime, null, sqlite?.adapter ?? null);
    return {
      ...runtime,
      storageScope: null,
      sqlite: null,
      dispose: () => undefined,
    };
  }
  if (sqlite?.store !== undefined) {
    try {
      persistence = createLocalSessionPersistence({
        controller: runtime.binding.controller,
        store: sqlite.store,
        now,
      });
    } catch {
      disposeResources(runtime, persistence, sqlite.adapter);
      return unavailable('native_runtime_failed');
    }
  }
  return readyRuntimeFor(runtime, scope, sqlite, persistence);
};

export const nativeMobileRuntimeMessage = (
  reason: NativeMobileRuntimeReason | null,
): string | null => {
  if (reason === null) return null;
  if (reason === 'native_credentials_missing' || reason === 'native_secure_store_unavailable') {
    return '接続設定を確認してから、もう一度試してください。';
  }
  if (reason === 'native_credentials_invalid' || reason === 'native_scope_mismatch') {
    return '接続設定を確認してから、もう一度試してください。';
  }
  if (reason === 'native_init_timeout') return '接続の準備に時間がかかっています。';
  if (reason === 'native_initialization_aborted') return '接続の準備を取り消しました。';
  if (reason === 'native_sqlite_unavailable') return '端末の保存領域を利用できません。';
  if (reason === 'native_runtime_failed')
    return '検索を開始できません。アプリ設定を確認してください。';
  if (reason === 'native_authority_invalid')
    return '接続設定を確認してから、もう一度試してください。';
  const runtimeMessage = mobileJourneyRuntimeMessage(reason);
  if (runtimeMessage !== null) return runtimeMessage;
  return null;
};
