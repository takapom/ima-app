import {
  parseSavedReferencePath,
  type CreateThreadRequest,
  type LifecycleCommand,
  type LocationSnapshot,
  type Preferences,
  type PublicCard,
  type RetentionMetadata,
  type SearchRequest,
  type ThreadTurnRequest,
} from '@ima/contracts';
import type {
  JourneyApiCancelFactoryInput,
  JourneyApiControllerBinding,
  JourneyApiRequestFactory,
  JourneyApiSearchFactoryInput,
  JourneyApiTurnFactoryInput,
  JourneySavedPlacePreviewBinding,
} from './journey-api-binding';
import {
  createJourneyApiController,
  type JourneyApiControllerState,
  type JourneyLocalRestorePort,
} from './journey-controller';
import { createJourneyApiClient } from './client';
import { createJourneyPhotoClient } from './photo-client';
import { createRuntimeId } from '../runtime-id';
import { createSavedReferenceJourneyStorage, type JourneyStorageService } from '../journey-storage';
import { createSavedPlaceListService } from '../saved-place-list';
import { createSavedReferenceService, type SavedReferenceScope } from '../saved-reference-service';
import type { SqliteStore } from '../sqlite/types';
import type { LocationService } from '../location/types';
import type { ApiCredentialProvider, ApiCredentials, ApiFetch } from './types';
import { projectAssistantResponseState } from '../../state/assistant-response-projection';

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

export type MobileJourneySavedReferenceOptions = {
  /** A host-owned SQLite adapter; no native SDK is selected by this module. */
  readonly sqlite: SqliteStore;
  /** Owner-scoped reference policy, independent from provider card payload policy. */
  readonly referenceRetentionFor: (candidate: PublicCard) => RetentionMetadata | null;
};

export type MobileJourneyRuntimeOptions = {
  readonly env?: MobileRuntimeEnvironment;
  /** Native credential storage will provide this in a later integration unit. */
  readonly credentials?: ApiCredentialProvider;
  readonly fetchImpl?: ApiFetch;
  readonly now?: () => string;
  readonly requestIdFactory?: () => string;
  readonly idFactory?: (prefix: string) => string;
  /** Host-composed metadata-only restore; response payloads are fetched again. */
  readonly localRestore?: JourneyLocalRestorePort;
  /** Both fields are required to connect saving; partial injection fails closed. */
  readonly savedReference?: MobileJourneySavedReferenceOptions;
  /** Host-composed foreground location service; acquisition remains submit-triggered. */
  readonly location?: LocationService;
};

type RequestFactoryOptions = {
  readonly now: () => string;
  readonly idFactory: (prefix: string) => string;
};

export class JourneyApiRequestFactoryError extends Error {
  readonly code = 'INVALID_SAVED_PLACE_REFS' as const;

  constructor(readonly issue: 'not_array' | 'too_many' | 'invalid_ref' | 'duplicate') {
    super('savedPlaceRefs failed request validation');
    this.name = 'JourneyApiRequestFactoryError';
  }
}

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

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item: unknown): item is string => typeof item === 'string');

const savedPlaceRefsFor = (refs: unknown): string[] => {
  if (refs === undefined) return [];
  if (!isStringArray(refs)) {
    throw new JourneyApiRequestFactoryError(Array.isArray(refs) ? 'invalid_ref' : 'not_array');
  }
  if (refs.length > 50) throw new JourneyApiRequestFactoryError('too_many');
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!parseSavedReferencePath({ savedPlaceRef: ref }).success) {
      throw new JourneyApiRequestFactoryError('invalid_ref');
    }
    if (seen.has(ref)) throw new JourneyApiRequestFactoryError('duplicate');
    seen.add(ref);
  }
  return [...refs];
};

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
    location: input.location ?? unavailableLocation,
    prefs: preferencesFor(input),
    cardSetId: input.context.cardSetId,
    promotedCandidateId: input.context.promotedCandidateId,
    selectedCandidateId: input.context.selectedCandidateId,
    candidateOrder: [...input.context.candidateOrder],
    savedPlaceRefs: savedPlaceRefsFor(input.context.savedPlaceRefs),
    excludeCandidateIds: [...input.context.excludeCandidateIds],
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

const isFutureTimestamp = (value: string, now: () => string): boolean => {
  try {
    const nowMilliseconds = Date.parse(now());
    const expiryMilliseconds = Date.parse(value);
    return Boolean(
      Number.isFinite(nowMilliseconds) &&
      Number.isFinite(expiryMilliseconds) &&
      nowMilliseconds < expiryMilliseconds,
    );
  } catch {
    return false;
  }
};

const earliestExpiry = (...values: readonly (string | null | undefined)[]): string | null => {
  let earliest: { readonly value: string; readonly milliseconds: number } | null = null;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) return null;
    if (earliest === null || milliseconds < earliest.milliseconds) {
      earliest = { value, milliseconds };
    }
  }
  return earliest?.value ?? null;
};

const responseSessionExpiryFor = (
  responseState: JourneyApiControllerState['responseState'],
): string | null => {
  if (responseState === null) return null;
  const values: string[] = [];
  const cards = responseState.cards;
  if (cards !== null) {
    for (const card of [cards.hero, ...cards.alts]) {
      values.push(card.why.retention.sessionExpiresAt);
      values.push(...card.why.evidence.map((item) => item.retention.sessionExpiresAt));
      if (card.diff !== undefined) {
        values.push(card.diff.retention.sessionExpiresAt);
        values.push(...card.diff.evidence.map((item) => item.retention.sessionExpiresAt));
      }
      for (const field of Object.values(card.facts)) {
        if (field?.status === 'known') {
          values.push(...field.evidence.map((item) => item.retention.sessionExpiresAt));
        }
      }
    }
  }
  for (const record of responseState.responseRecords) {
    for (const message of record.messages) {
      values.push(message.retention.sessionExpiresAt);
      values.push(...message.evidence.map((item) => item.retention.sessionExpiresAt));
    }
  }
  return earliestExpiry(...values);
};

const visibleCandidateFor = (
  controller: JourneyApiControllerBinding['controller'],
  candidateId: string,
  now: () => string,
): boolean => {
  const responseState = controller.getState().responseState;
  if (responseState === null) return false;
  try {
    const projected = projectAssistantResponseState(responseState, now());
    const cards = projected.cards;
    const card =
      cards === null
        ? undefined
        : [cards.hero, ...cards.alts].find((item) => item.candidateId === candidateId);
    if (card === undefined || card.why.retention.displayPolicyStatus !== 'available') {
      return false;
    }
    const identity = card.facts.identity;
    return (
      identity.status === 'known' &&
      identity.evidence.every((item) => item.retention.displayPolicyStatus === 'available')
    );
  } catch {
    return false;
  }
};

type SavedReferenceRuntimeServices = {
  readonly storage: JourneyStorageService;
  readonly savedPlacePreview: JourneySavedPlacePreviewBinding;
};

const savedReferenceRuntimeServicesFor = (
  controller: JourneyApiControllerBinding['controller'],
  api: Parameters<typeof createSavedReferenceService>[0]['api'],
  options: MobileJourneySavedReferenceOptions | undefined,
  now: () => string,
  requestIdFactory: () => string,
): SavedReferenceRuntimeServices | undefined => {
  if (options === undefined) return undefined;

  const currentScope = (): SavedReferenceScope | null => {
    const state = controller.getState();
    if (state.status !== 'idle' || state.threadId === null || state.responseState === null) {
      return null;
    }
    const sessionExpiresAt = earliestExpiry(
      state.localSnapshot?.sessionExpiresAt,
      responseSessionExpiryFor(state.responseState),
    );
    if (sessionExpiresAt === null || !isFutureTimestamp(sessionExpiresAt, now)) {
      return null;
    }
    const revision = state.responseState.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) return null;
    return { threadId: state.threadId, revision };
  };
  const referenceRetentionFor = (candidate: PublicCard): RetentionMetadata | null => {
    try {
      const retention = options.referenceRetentionFor(candidate);
      return retention !== null && isFutureTimestamp(retention.sessionExpiresAt, now)
        ? retention
        : null;
    } catch {
      return null;
    }
  };
  const service = createSavedReferenceService({
    api,
    sqlite: options.sqlite,
    currentScope,
    requestIdFactory,
  });
  const storage = createSavedReferenceJourneyStorage({
    service,
    currentScope,
    referenceRetentionFor,
  });
  return {
    storage: {
      saveCandidate: (candidate, saveOptions) => {
        if (!visibleCandidateFor(controller, candidate.candidateId, now)) {
          return Promise.resolve({ status: 'failed', reason: 'stale' as const });
        }
        return storage.saveCandidate(candidate, saveOptions);
      },
    },
    savedPlacePreview: {
      listService: createSavedPlaceListService({ sqlite: options.sqlite, now }),
      refreshService: service,
      now,
    },
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
  const idFactory = options.idFactory ?? createRuntimeId;
  const now = options.now ?? (() => new Date().toISOString());
  const requestIdFactory = options.requestIdFactory ?? (() => idFactory('request'));
  const clientOptions = {
    baseUrl,
    mode: selected.mode,
    appVersion: valueFor(env, 'EXPO_PUBLIC_APP_VERSION') ?? '0.0.0',
    credentials,
    requestIdFactory,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  } as const;
  const api = createJourneyApiClient(clientOptions);
  const controller = createJourneyApiController({
    api,
    clock: now,
    ...(options.localRestore === undefined ? {} : { localRestore: options.localRestore }),
  });
  const photoClient = createJourneyPhotoClient({ ...clientOptions, now });
  const savedReferenceServices = savedReferenceRuntimeServicesFor(
    controller,
    api,
    options.savedReference,
    now,
    requestIdFactory,
  );
  return {
    mode: selected.mode,
    reason: null,
    binding: {
      controller,
      photoClient,
      requests: createJourneyApiRequestFactory({ now, idFactory }),
      ...(options.location === undefined ? {} : { location: options.location }),
      ...(savedReferenceServices === undefined
        ? {}
        : {
            storage: savedReferenceServices.storage,
            savedPlacePreview: savedReferenceServices.savedPlacePreview,
          }),
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
