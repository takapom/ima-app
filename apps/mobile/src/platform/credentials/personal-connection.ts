import {
  createExpoSecureStoreClient,
  createSecureStoreCredentialStore,
  nativeCredentialScopeFor,
  type NativeCredentialAuthority,
  type NativeCredentialStoreClient,
} from '@mobile/platform/credentials/native-credentials';

export type PersonalConnectionTarget = {
  readonly environment: 'staging';
  readonly apiBaseUrl: string;
};

export type PersonalConnectionResult =
  | { readonly status: 'ready'; readonly authority: NativeCredentialAuthority }
  | { readonly status: 'missing' | 'invalid' | 'unavailable' | 'invalid_token' };

export type PersonalConnectionDependencies = {
  readonly secureStore?: NativeCredentialStoreClient;
  readonly randomId?: () => Promise<string>;
  readonly randomBytes?: () => Promise<Uint8Array>;
};

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const ownerCredentialFor = (bytes: Uint8Array): string => {
  if (bytes.length !== 32) throw new Error('PERSONAL_CREDENTIAL_RANDOM_BYTES_INVALID');
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

/** The public scope pointer and credentials both stay in device-only SecureStore. */
export const createPersonalConnection = (
  target: PersonalConnectionTarget,
  dependencies: PersonalConnectionDependencies = {},
) => {
  const client = dependencies.secureStore ?? createExpoSecureStoreClient();
  const randomId =
    dependencies.randomId ?? (async () => (await import('expo-crypto')).randomUUID());
  const randomBytes =
    dependencies.randomBytes ?? (async () => (await import('expo-crypto')).getRandomBytesAsync(32));
  const scope = nativeCredentialScopeFor({ ...target, storageScope: 'personal' });
  const pointerKey =
    scope === null ? null : `ima.personal.scope.${hex(new TextEncoder().encode(scope.apiOrigin))}`;

  const readRecord = async () => {
    if (pointerKey === null) return { status: 'invalid' } as const;
    const options = await client.secureStoreOptions();
    const id = await client.getItemAsync(pointerKey, options);
    if (id === null) return { status: 'missing' } as const;
    if (!ID.test(id)) return { status: 'invalid' } as const;
    const authority: NativeCredentialAuthority = { ...target, storageScope: `personal-${id}` };
    const store = createSecureStoreCredentialStore({ authority, secureStore: client });
    const loaded = await store.load();
    if (loaded.status !== 'available') return { status: loaded.status };
    return { status: 'ready', authority, credentials: loaded.credentials, store } as const;
  };

  const load = async (): Promise<PersonalConnectionResult> => {
    try {
      const record = await readRecord();
      return record.status === 'ready'
        ? { status: 'ready', authority: record.authority }
        : { status: record.status };
    } catch {
      return { status: 'unavailable' };
    }
  };

  const save = async (appToken: string): Promise<PersonalConnectionResult> => {
    if (!/^[a-f0-9]{64}$/u.test(appToken)) return { status: 'invalid_token' };
    if (pointerKey === null) return { status: 'invalid' };
    try {
      const previous = await readRecord();
      if (previous.status !== 'ready' && previous.status !== 'missing')
        return { status: previous.status };
      const id = previous.status === 'ready' ? null : await randomId();
      if (id !== null && !ID.test(id)) return { status: 'invalid' };
      const authority: NativeCredentialAuthority =
        previous.status === 'ready'
          ? previous.authority
          : { ...target, storageScope: `personal-${id}` };
      const store = createSecureStoreCredentialStore({ authority, secureStore: client });
      const credentials =
        previous.status === 'ready'
          ? { ...previous.credentials, appToken }
          : {
              appToken,
              deviceId: await randomId(),
              ownerCredential: ownerCredentialFor(await randomBytes()),
            };
      const saved = await store.save(credentials);
      if (saved.status !== 'saved')
        return { status: saved.status === 'rejected' ? 'invalid' : 'unavailable' };
      // Publish a fresh namespace only after credentials were saved successfully.
      // A missing credential record never restores another owner's SQLite namespace.
      if (id !== null) await client.setItemAsync(pointerKey, id, await client.secureStoreOptions());
      return { status: 'ready', authority };
    } catch {
      return { status: 'unavailable' };
    }
  };

  return { load, save };
};
