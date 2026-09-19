import { parseRequestHeaders } from '@ima/contracts';
import type { ApiCredentials } from '@mobile/platform/http/api';
import type { SecureStoreOptions } from 'expo-secure-store';

export const NATIVE_CREDENTIALS_KEY_PREFIX = 'ima.api.credentials.v1.' as const;

const VALIDATION_REQUEST_ID = 'credential-validation';
const VALIDATION_APP_VERSION = 'mobile';
const MAX_API_BASE_URL_LENGTH = 512;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const STORAGE_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export const NATIVE_CREDENTIALS_SCHEMA_VERSION = 'v1' as const;

export type NativeCredentialEnvironment = 'dev' | 'staging' | 'production';

/**
 * The host supplies a non-secret namespace. It is deliberately not derived
 * from deviceId or ownerCredential and is safe for a later SQLite namespace.
 */
export type NativeCredentialAuthority = {
  readonly environment: NativeCredentialEnvironment;
  readonly apiBaseUrl: string;
  readonly storageScope: string;
};

/** Public scope metadata; credentials never appear in this value. */
export type NativeCredentialScope = {
  readonly environment: NativeCredentialEnvironment;
  readonly apiOrigin: string;
  readonly storageScope: string;
};

export type NativeCredentialStoreClient = {
  /** Production clients return the SDK's device-only accessibility constant. */
  readonly secureStoreOptions: () => Promise<SecureStoreOptions>;
  readonly isAvailableAsync: () => Promise<boolean>;
  readonly getItemAsync: (key: string, options?: SecureStoreOptions) => Promise<string | null>;
  readonly setItemAsync: (
    key: string,
    value: string,
    options?: SecureStoreOptions,
  ) => Promise<void>;
  readonly deleteItemAsync: (key: string, options?: SecureStoreOptions) => Promise<void>;
};

export type NativeCredentialStoreFailureReason =
  | 'missing'
  | 'invalid_authority'
  | 'invalid_credentials'
  | 'invalid_record'
  | 'authority_mismatch'
  | 'sdk_unavailable'
  | 'sdk_error';

export type NativeCredentialLoadResult =
  | {
      readonly status: 'available';
      readonly credentials: ApiCredentials;
      readonly scope: NativeCredentialScope;
    }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly reason: 'invalid_record' | 'authority_mismatch' }
  | {
      readonly status: 'unavailable';
      readonly reason: 'invalid_authority' | 'sdk_unavailable' | 'sdk_error';
    };

export type NativeCredentialSaveResult =
  | { readonly status: 'saved'; readonly scope: NativeCredentialScope }
  | {
      readonly status: 'rejected';
      readonly reason: 'invalid_authority' | 'invalid_credentials';
    }
  | { readonly status: 'unavailable'; readonly reason: 'sdk_unavailable' | 'sdk_error' };

export type NativeCredentialDeleteResult =
  | { readonly status: 'deleted' }
  | { readonly status: 'rejected'; readonly reason: 'invalid_authority' }
  | { readonly status: 'unavailable'; readonly reason: 'sdk_unavailable' | 'sdk_error' };

export type NativeCredentialStore = {
  readonly scope: NativeCredentialScope | null;
  readonly load: () => Promise<NativeCredentialLoadResult>;
  readonly save: (credentials: ApiCredentials) => Promise<NativeCredentialSaveResult>;
  readonly delete: () => Promise<NativeCredentialDeleteResult>;
  readonly provider: NativeCredentialProvider;
};

/** A function-shaped provider, assignable to the wider ApiCredentialProvider port. */
export type NativeCredentialProvider = () => Promise<ApiCredentials>;

export class NativeCredentialProviderError extends Error {
  readonly code: NativeCredentialStoreFailureReason;

  constructor(code: NativeCredentialStoreFailureReason) {
    super('native API credentials are unavailable');
    this.name = 'NativeCredentialProviderError';
    this.code = code;
  }
}

type StoredCredentialRecord = {
  readonly schemaVersion: typeof NATIVE_CREDENTIALS_SCHEMA_VERSION;
  readonly authority: NativeCredentialScope;
  readonly credentials: ApiCredentials;
};

type StoreCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'sdk_unavailable' | 'sdk_error' };

type ConfiguredLoadResult =
  | Extract<NativeCredentialLoadResult, { readonly status: 'available' | 'missing' | 'invalid' }>
  | {
      readonly status: 'unavailable';
      readonly reason: 'sdk_unavailable' | 'sdk_error';
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
};

const environmentIsValid = (value: unknown): value is NativeCredentialEnvironment =>
  value === 'dev' || value === 'staging' || value === 'production';

const canonicalApiOriginFor = (
  value: unknown,
  environment: NativeCredentialEnvironment,
): string | null => {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return null;
  if (value.length > MAX_API_BASE_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin === 'null'
  ) {
    return null;
  }
  if (environment === 'dev') {
    if (parsed.protocol === 'http:' && !LOCAL_HOSTNAMES.has(parsed.hostname)) return null;
  } else if (parsed.protocol !== 'https:' || LOCAL_HOSTNAMES.has(parsed.hostname)) {
    return null;
  }
  return parsed.origin;
};

const scopeFor = (authority: NativeCredentialAuthority): NativeCredentialScope | null => {
  if (!isRecord(authority) || !environmentIsValid(authority.environment)) return null;
  if (
    typeof authority.storageScope !== 'string' ||
    !STORAGE_SCOPE_PATTERN.test(authority.storageScope)
  ) {
    return null;
  }
  const apiOrigin = canonicalApiOriginFor(authority.apiBaseUrl, authority.environment);
  return apiOrigin === null
    ? null
    : {
        environment: authority.environment,
        apiOrigin,
        storageScope: authority.storageScope,
      };
};

const storageKeyForScope = (scope: NativeCredentialScope): string => {
  const encoded = Array.from(new TextEncoder().encode(JSON.stringify(scope)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${NATIVE_CREDENTIALS_KEY_PREFIX}${encoded}`;
};

export const nativeCredentialScopeFor = (
  authority: NativeCredentialAuthority,
): NativeCredentialScope | null => scopeFor(authority);

/** Returns a non-secret, collision-free SecureStore key for an authority. */
export const nativeCredentialStorageKeyFor = (
  authority: NativeCredentialAuthority,
): string | null => {
  const scope = scopeFor(authority);
  return scope === null ? null : storageKeyForScope(scope);
};

const credentialsFor = (value: unknown): ApiCredentials | null => {
  if (!isRecord(value)) return null;
  const parsed = parseRequestHeaders({
    ...value,
    requestId: VALIDATION_REQUEST_ID,
    appVersion: VALIDATION_APP_VERSION,
  });
  if (!parsed.success) return null;
  return {
    appToken: parsed.data.appToken,
    deviceId: parsed.data.deviceId,
    ownerCredential: parsed.data.ownerCredential,
  };
};

const storedRecordFor = (raw: string): StoredCredentialRecord | null => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || !hasExactKeys(value, ['authority', 'credentials', 'schemaVersion'])) {
    return null;
  }
  if (value.schemaVersion !== NATIVE_CREDENTIALS_SCHEMA_VERSION) return null;
  const authority = value.authority;
  if (
    !isRecord(authority) ||
    !hasExactKeys(authority, ['apiOrigin', 'environment', 'storageScope'])
  ) {
    return null;
  }
  if (!environmentIsValid(authority.environment)) return null;
  const apiOrigin = canonicalApiOriginFor(authority.apiOrigin, authority.environment);
  if (apiOrigin === null || apiOrigin !== authority.apiOrigin) return null;
  if (
    typeof authority.storageScope !== 'string' ||
    !STORAGE_SCOPE_PATTERN.test(authority.storageScope)
  ) {
    return null;
  }
  const credentials = credentialsFor(value.credentials);
  return credentials === null
    ? null
    : {
        schemaVersion: NATIVE_CREDENTIALS_SCHEMA_VERSION,
        authority: {
          environment: authority.environment,
          apiOrigin,
          storageScope: authority.storageScope,
        },
        credentials,
      };
};

const scopesMatch = (left: NativeCredentialScope, right: NativeCredentialScope): boolean =>
  left.environment === right.environment &&
  left.apiOrigin === right.apiOrigin &&
  left.storageScope === right.storageScope;

const createExpoSecureStoreClient = (): NativeCredentialStoreClient => ({
  secureStoreOptions: async () => {
    const secureStore = await import('expo-secure-store');
    return {
      keychainService: NATIVE_CREDENTIALS_KEY_PREFIX,
      keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    };
  },
  isAvailableAsync: async () => (await import('expo-secure-store')).isAvailableAsync(),
  getItemAsync: async (key, options) =>
    (await import('expo-secure-store')).getItemAsync(key, options),
  setItemAsync: async (key, value, options) =>
    (await import('expo-secure-store')).setItemAsync(key, value, options),
  deleteItemAsync: async (key, options) =>
    (await import('expo-secure-store')).deleteItemAsync(key, options),
});

const callStore = async <T>(
  client: NativeCredentialStoreClient,
  operation: (options: SecureStoreOptions) => Promise<T>,
): Promise<StoreCallResult<T>> => {
  let available: boolean;
  try {
    available = await client.isAvailableAsync();
  } catch {
    return { ok: false, reason: 'sdk_error' };
  }
  if (!available) return { ok: false, reason: 'sdk_unavailable' };
  try {
    const secureStoreOptions = await client.secureStoreOptions();
    return { ok: true, value: await operation(secureStoreOptions) };
  } catch {
    return { ok: false, reason: 'sdk_error' };
  }
};

const credentialsForProvider = (result: NativeCredentialLoadResult): ApiCredentials => {
  if (result.status === 'available') return result.credentials;
  const code = result.status === 'missing' ? 'missing' : result.reason;
  throw new NativeCredentialProviderError(code);
};

export const createSecureStoreCredentialStore = (options: {
  readonly authority: NativeCredentialAuthority;
  readonly secureStore?: NativeCredentialStoreClient;
}): NativeCredentialStore => {
  const scope = scopeFor(options.authority);
  const client = options.secureStore ?? createExpoSecureStoreClient();

  const loadConfigured = async (
    configuredScope: NativeCredentialScope,
  ): Promise<ConfiguredLoadResult> => {
    const storageKey = storageKeyForScope(configuredScope);
    const result = await callStore(client, (secureStoreOptions) =>
      client.getItemAsync(storageKey, secureStoreOptions),
    );
    if (!result.ok) return { status: 'unavailable', reason: result.reason };
    if (result.value === null) return { status: 'missing' };
    const record = storedRecordFor(result.value);
    if (record === null) return { status: 'invalid', reason: 'invalid_record' };
    if (!scopesMatch(record.authority, configuredScope)) {
      return { status: 'invalid', reason: 'authority_mismatch' };
    }
    return { status: 'available', credentials: record.credentials, scope: configuredScope };
  };

  const load = async (): Promise<NativeCredentialLoadResult> => {
    if (scope === null) return { status: 'unavailable', reason: 'invalid_authority' };
    return loadConfigured(scope);
  };

  const save = async (credentials: ApiCredentials): Promise<NativeCredentialSaveResult> => {
    if (scope === null) return { status: 'rejected', reason: 'invalid_authority' };
    const parsedCredentials = credentialsFor(credentials);
    if (parsedCredentials === null) {
      return { status: 'rejected', reason: 'invalid_credentials' };
    }
    const record: StoredCredentialRecord = {
      schemaVersion: NATIVE_CREDENTIALS_SCHEMA_VERSION,
      authority: scope,
      credentials: parsedCredentials,
    };
    const result = await callStore(client, (secureStoreOptions) =>
      client.setItemAsync(storageKeyForScope(scope), JSON.stringify(record), secureStoreOptions),
    );
    return result.ok
      ? { status: 'saved', scope }
      : { status: 'unavailable', reason: result.reason };
  };

  const remove = async (): Promise<NativeCredentialDeleteResult> => {
    if (scope === null) return { status: 'rejected', reason: 'invalid_authority' };
    const storageKey = storageKeyForScope(scope);
    const result = await callStore(client, (secureStoreOptions) =>
      client.deleteItemAsync(storageKey, secureStoreOptions),
    );
    return result.ok ? { status: 'deleted' } : { status: 'unavailable', reason: result.reason };
  };

  const provider: NativeCredentialProvider = async () => credentialsForProvider(await load());

  return { scope, load, save, delete: remove, provider };
};

export const createSecureStoreCredentialProvider = (options: {
  readonly authority: NativeCredentialAuthority;
  readonly secureStore?: NativeCredentialStoreClient;
}): NativeCredentialProvider => createSecureStoreCredentialStore(options).provider;
