import type {
  CreateThreadRequest,
  LocationSnapshot,
  LifecycleCommand,
  Preferences,
  SearchRequest,
  ThreadTurnRequest,
} from '@ima/contracts';
import type {
  JourneyApiCancelFactoryInput,
  JourneyApiControllerBinding,
  JourneyApiRequestFactory,
  JourneyApiSearchFactoryInput,
  JourneyApiTurnFactoryInput,
} from './journey-api-binding';
import { createJourneyApiComposition } from './composition';
import type { ApiCredentialProvider, ApiCredentials, ApiFetch } from './types';

export type MobileRuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type MobileJourneyRuntimeMode = 'fixture' | 'live' | 'unconfigured';
export type MobileJourneyRuntimeReason =
  | 'mode_missing'
  | 'mode_invalid'
  | 'disabled'
  | 'endpoint_missing'
  | 'endpoint_invalid'
  | 'fixture_requires_dev'
  | 'fixture_credentials_missing'
  | 'live_credentials_unavailable';

export type MobileJourneyRuntime = {
  readonly mode: MobileJourneyRuntimeMode;
  readonly binding: JourneyApiControllerBinding | null;
  readonly reason: MobileJourneyRuntimeReason | null;
};

export type MobileJourneyRuntimeOptions = {
  readonly env?: MobileRuntimeEnvironment;
  /** Native credential storage will provide this in a later integration unit. */
  readonly credentials?: ApiCredentialProvider;
  readonly fetchImpl?: ApiFetch;
  readonly now?: () => string;
  readonly requestIdFactory?: () => string;
  readonly idFactory?: (prefix: string) => string;
};

type RequestFactoryOptions = {
  readonly now: () => string;
  readonly idFactory: (prefix: string) => string;
};

const unavailable = (reason: MobileJourneyRuntimeReason): MobileJourneyRuntime => ({
  mode: 'unconfigured',
  binding: null,
  reason,
});

const valueFor = (env: MobileRuntimeEnvironment, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

const modeFor = (
  env: MobileRuntimeEnvironment,
): { readonly mode: 'fixture' | 'live' } | { readonly reason: MobileJourneyRuntimeReason } => {
  const value = valueFor(env, 'EXPO_PUBLIC_API_MODE');
  if (value === 'fixture' || value === 'live') return { mode: value };
  if (value === 'disabled') return { reason: 'disabled' };
  return { reason: value === undefined ? 'mode_missing' : 'mode_invalid' };
};

const credentialsFor = (
  env: MobileRuntimeEnvironment,
  mode: 'fixture' | 'live',
  injected: ApiCredentialProvider | undefined,
): ApiCredentialProvider | null => {
  if (injected !== undefined) return injected;
  if (mode === 'live') return null;
  const appToken = valueFor(env, 'EXPO_PUBLIC_FIXTURE_APP_TOKEN');
  const deviceId = valueFor(env, 'EXPO_PUBLIC_FIXTURE_DEVICE_ID');
  const ownerCredential = valueFor(env, 'EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL');
  return appToken === undefined || deviceId === undefined || ownerCredential === undefined
    ? null
    : { appToken, deviceId, ownerCredential };
};

let fallbackIdSequence = 0;

const randomId = (prefix: string): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid === undefined
    ? `${prefix}-${Date.now().toString(36)}-${++fallbackIdSequence}`
    : `${prefix}-${uuid}`;
};

const unavailableLocation: LocationSnapshot = {
  status: 'unavailable',
  lat: null,
  lng: null,
  accuracyMeters: null,
  precise: false,
  capturedAt: null,
};

const expoEnvironment = (): MobileRuntimeEnvironment => ({
  // Expo substitutes these direct property references during bundling. Keep
  // this list explicit; a dynamic process.env lookup is not bundled reliably.
  EXPO_PUBLIC_ENVIRONMENT: process.env.EXPO_PUBLIC_ENVIRONMENT,
  EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
  EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
  EXPO_PUBLIC_APP_VERSION: process.env.EXPO_PUBLIC_APP_VERSION,
  EXPO_PUBLIC_FIXTURE_APP_TOKEN: process.env.EXPO_PUBLIC_FIXTURE_APP_TOKEN,
  EXPO_PUBLIC_FIXTURE_DEVICE_ID: process.env.EXPO_PUBLIC_FIXTURE_DEVICE_ID,
  EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL: process.env.EXPO_PUBLIC_FIXTURE_OWNER_CREDENTIAL,
});

const preferencesFor = (input: JourneyApiSearchFactoryInput): Preferences => ({
  // A free-form station label is not a server station reference. Keep it out
  // of the request until the station resolver contract is connected.
  homeStationRef: null,
  maxWalkMinutes: input.context.conditions.maxWalkMinutes,
  minimumStayMinutes: null,
  areaText: null,
  budget: input.context.conditions.budget,
});

export const createJourneyApiRequestFactory = (
  options: RequestFactoryOptions,
): JourneyApiRequestFactory => {
  const createFields = (
    input: JourneyApiSearchFactoryInput | JourneyApiTurnFactoryInput,
    turnId: string | null,
  ) => ({
    schemaVersion: 'v1' as const,
    requestId: options.idFactory('request'),
    turnId,
    revision: input.revision,
    text: input.query,
    clientNow: options.now(),
    location: unavailableLocation,
    prefs: preferencesFor(input),
    savedPlaceRefs: [],
    excludeCandidateIds: [],
    mode: 'search' as const,
    idempotencyKey: options.idFactory('operation'),
  });

  return {
    createThread: (): CreateThreadRequest => ({
      schemaVersion: 'v1',
      requestId: options.idFactory('request'),
      idempotencyKey: options.idFactory('operation'),
    }),
    search: (input): SearchRequest => ({
      ...createFields(input, null),
      threadId: input.threadId,
    }),
    turn: (input): ThreadTurnRequest => createFields(input, input.turnId),
    cancel: (input: JourneyApiCancelFactoryInput): LifecycleCommand => ({
      schemaVersion: 'v1',
      requestId: options.idFactory('request'),
      turnId: input.turnId,
      revision: input.revision,
      idempotencyKey: options.idFactory('operation'),
    }),
  };
};

export const createMobileJourneyRuntime = (
  options: MobileJourneyRuntimeOptions = {},
): MobileJourneyRuntime => {
  const env = options.env ?? expoEnvironment();
  const selected = modeFor(env);
  if ('reason' in selected) return unavailable(selected.reason);
  const environment = valueFor(env, 'EXPO_PUBLIC_ENVIRONMENT');
  if (selected.mode === 'fixture' && environment !== undefined && environment !== 'dev') {
    return unavailable('fixture_requires_dev');
  }
  const baseUrl = valueFor(env, 'EXPO_PUBLIC_API_BASE_URL');
  if (baseUrl === undefined) return unavailable('endpoint_missing');
  if (selected.mode === 'live') {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:') return unavailable('endpoint_invalid');
    } catch {
      return unavailable('endpoint_invalid');
    }
  }
  const credentials = credentialsFor(env, selected.mode, options.credentials);
  if (credentials === null) {
    return unavailable(
      selected.mode === 'live' ? 'live_credentials_unavailable' : 'fixture_credentials_missing',
    );
  }
  const idFactory = options.idFactory ?? randomId;
  const now = options.now ?? (() => new Date().toISOString());
  const requestIdFactory = options.requestIdFactory ?? (() => idFactory('request'));
  const controller = createJourneyApiComposition({
    baseUrl,
    mode: selected.mode,
    appVersion: valueFor(env, 'EXPO_PUBLIC_APP_VERSION') ?? '0.0.0',
    credentials,
    requestIdFactory,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return {
    mode: selected.mode,
    reason: null,
    binding: {
      controller,
      requests: createJourneyApiRequestFactory({ now, idFactory }),
    },
  };
};

export const mobileJourneyRuntimeMessage = (
  reason: MobileJourneyRuntimeReason | null,
): string | null => {
  if (reason === null) return null;
  if (reason === 'live_credentials_unavailable') {
    return '接続設定を確認してから、もう一度試してください。';
  }
  if (reason === 'fixture_credentials_missing') {
    return 'ローカル接続の設定がありません。開発環境を確認してください。';
  }
  if (reason === 'fixture_requires_dev') {
    return 'fixture接続は開発環境でのみ利用できます。';
  }
  if (reason === 'disabled') return '検索機能は現在利用できません。';
  return '検索を開始できません。アプリ設定を確認してください。';
};

export type { ApiCredentials };
