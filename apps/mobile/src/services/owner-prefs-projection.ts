import {
  parseSavedReferencePath,
  type Preferences,
  type PrefsWriteResponse,
  type RetentionMetadata,
} from '@ima/contracts';
import type { OwnerPrefsClient } from './api/owner-client';
import type { ApiError, ApiResult } from './api/api';
import {
  createJourneyPreferencesService,
  isValidJourneyConditions,
  type JourneyPreferencesReadResult,
  type JourneyPreferencesSaveResult,
} from './preferences';
import type { ServerSavedPlaceRef } from './saved-place-types';
import { sessionExpiryAt } from './sqlite/retention';
import type { SqliteStore } from './sqlite/types';
import type { JourneyConditions } from '../state/journey-input';

export type OwnerPrefsSqlite = Pick<SqliteStore, 'readPreferences' | 'savePreferences'> &
  Partial<Pick<SqliteStore, 'listSavedPlaces' | 'savePlace' | 'deleteSavedPlace' | 'markDecided'>>;

export type OwnerPrefsHydrateResult = {
  readonly prefs: 'synced' | 'stale';
  readonly saved: 'synced' | 'failed';
};

export type OwnerPrefsProjection = {
  readonly read: (fallback?: JourneyConditions) => JourneyPreferencesReadResult;
  readonly save: (conditions: JourneyConditions) => Promise<JourneyPreferencesSaveResult>;
  readonly hydrate: () => Promise<OwnerPrefsHydrateResult>;
};

export type OwnerPrefsProjectionOptions = {
  readonly api: OwnerPrefsClient;
  readonly sqlite: OwnerPrefsSqlite;
  readonly requestIdFactory: () => string;
  readonly now?: () => string;
};

const emptyPreferences = (): Preferences => ({
  homeStationRef: null,
  maxWalkMinutes: null,
  minimumStayMinutes: null,
  areaText: null,
  budget: null,
});

const ownerScopedRetention = (now: string): RetentionMetadata => ({
  retentionDecision: 'allow',
  retentionMode: 'identifier_indefinite_owner_scoped',
  sessionExpiresAt: sessionExpiryAt(now),
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'reference_only',
  policyStatus: 'available',
  displayPolicyStatus: 'available',
});

const isServerSavedPlaceRef = (value: string): value is ServerSavedPlaceRef =>
  parseSavedReferencePath({ savedPlaceRef: value }).success;

const requestIdFor = (factory: () => string): string | null => {
  try {
    const requestId = factory();
    return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
  } catch {
    return null;
  }
};

const isRevisionConflict = (error: ApiError): boolean =>
  error.kind === 'http' && error.status === 409;

const publicEqual = (left: Preferences, right: Preferences): boolean =>
  left.homeStationRef === right.homeStationRef &&
  left.maxWalkMinutes === right.maxWalkMinutes &&
  left.minimumStayMinutes === right.minimumStayMinutes &&
  left.areaText === right.areaText &&
  left.budget === right.budget;

const publicPreferencesFrom = (
  stored: ReturnType<OwnerPrefsSqlite['readPreferences']>,
  conditions: JourneyConditions,
): Preferences => ({
  homeStationRef: stored?.homeStationRef ?? null,
  maxWalkMinutes: conditions.maxWalkMinutes,
  minimumStayMinutes: stored?.minimumStayMinutes ?? null,
  areaText: stored?.areaText ?? null,
  budget: conditions.budget,
});

const storedPublicPreferences = (
  stored: ReturnType<OwnerPrefsSqlite['readPreferences']>,
): Preferences =>
  stored === null
    ? emptyPreferences()
    : {
        homeStationRef: stored.homeStationRef,
        maxWalkMinutes: stored.maxWalkMinutes,
        minimumStayMinutes: stored.minimumStayMinutes,
        areaText: stored.areaText,
        budget: stored.budget,
      };

export const createOwnerPrefsProjection = (
  options: OwnerPrefsProjectionOptions,
): OwnerPrefsProjection => {
  const local = createJourneyPreferencesService(options.sqlite);
  const now = options.now ?? (() => new Date().toISOString());
  let revision = 0;
  let prefsStale = false;
  let hydrateInflight: Promise<OwnerPrefsHydrateResult> | null = null;

  const read = (fallback?: JourneyConditions): JourneyPreferencesReadResult => {
    const result = local.read(fallback);
    if (result.status !== 'available' || !prefsStale) return result;
    return { ...result, stale: true };
  };

  const writeServerPrefs = (prefs: Preferences | null): boolean => {
    try {
      options.sqlite.savePreferences(prefs ?? emptyPreferences());
      return true;
    } catch {
      return false;
    }
  };

  const hydratePrefs = async (): Promise<'synced' | 'stale'> => {
    let result: Awaited<ReturnType<OwnerPrefsClient['getPrefs']>>;
    try {
      result = await options.api.getPrefs();
    } catch {
      prefsStale = true;
      return 'stale';
    }
    if (!result.ok) {
      prefsStale = true;
      return 'stale';
    }
    revision = result.data.revision;
    if (!writeServerPrefs(result.data.prefs)) {
      prefsStale = true;
      return 'stale';
    }
    prefsStale = false;
    return 'synced';
  };

  const hydrateSaved = async (): Promise<'synced' | 'failed'> => {
    const { listSavedPlaces, savePlace, deleteSavedPlace, markDecided } = options.sqlite;
    if (
      listSavedPlaces === undefined ||
      savePlace === undefined ||
      deleteSavedPlace === undefined ||
      markDecided === undefined
    ) {
      return 'failed';
    }
    let listed: Awaited<ReturnType<OwnerPrefsClient['listSaved']>>;
    try {
      listed = await options.api.listSaved();
    } catch {
      return 'failed';
    }
    if (!listed.ok) return 'failed';
    const serverRefs = listed.data.savedPlaceRefs.filter(isServerSavedPlaceRef);
    try {
      const localPlaces = listSavedPlaces();
      for (const place of localPlaces) {
        const ref = place.serverSavedPlaceRef;
        if (ref === null) continue;
        if (serverRefs.includes(ref)) continue;
        deleteSavedPlace(place.localSavedEntryId);
      }
      const remaining = new Set(
        listSavedPlaces()
          .map((place) => place.serverSavedPlaceRef)
          .filter((ref): ref is ServerSavedPlaceRef => ref !== null),
      );
      const retention = ownerScopedRetention(now());
      for (const ref of serverRefs) {
        if (remaining.has(ref)) continue;
        savePlace({
          serverSavedPlaceRef: ref,
          referenceRetention: retention,
          display: null,
        });
      }
      const decided = listed.data.decided ?? [];
      const byRef = new Map(
        listSavedPlaces()
          .filter((place) => place.serverSavedPlaceRef !== null)
          .map((place) => [place.serverSavedPlaceRef, place.localSavedEntryId]),
      );
      for (const entry of decided) {
        if (!isServerSavedPlaceRef(entry.savedPlaceRef)) continue;
        const localId = byRef.get(entry.savedPlaceRef);
        if (localId === undefined) continue;
        markDecided(localId, entry.decidedAt);
      }
      return 'synced';
    } catch {
      return 'failed';
    }
  };

  const runHydrate = async (): Promise<OwnerPrefsHydrateResult> => {
    const [prefs, saved] = await Promise.all([hydratePrefs(), hydrateSaved()]);
    return { prefs, saved };
  };

  const hydrate = (): Promise<OwnerPrefsHydrateResult> => {
    if (hydrateInflight !== null) return hydrateInflight;
    const pending = runHydrate().finally(() => {
      if (hydrateInflight === pending) hydrateInflight = null;
    });
    hydrateInflight = pending;
    return pending;
  };

  const putPrefs = async (
    prefs: Preferences,
    expectedRevision: number,
  ): Promise<ApiResult<PrefsWriteResponse> | null> => {
    const requestId = requestIdFor(options.requestIdFactory);
    if (requestId === null) return null;
    return options.api.putPrefs({
      schemaVersion: 'v1',
      requestId,
      expectedRevision,
      prefs,
    });
  };

  const save = async (conditions: JourneyConditions): Promise<JourneyPreferencesSaveResult> => {
    if (!isValidJourneyConditions(conditions)) return { status: 'failed', reason: 'invalid_input' };
    let stored: ReturnType<OwnerPrefsSqlite['readPreferences']>;
    try {
      stored = options.sqlite.readPreferences();
    } catch {
      return { status: 'failed', reason: 'storage_unavailable' };
    }
    const nextPrefs = publicPreferencesFrom(stored, conditions);
    if (publicEqual(storedPublicPreferences(stored), nextPrefs)) {
      return local.save(conditions);
    }

    let write: Awaited<ReturnType<typeof putPrefs>>;
    try {
      write = await putPrefs(nextPrefs, revision);
    } catch {
      return { status: 'failed', reason: 'api' };
    }
    if (write === null) return { status: 'failed', reason: 'invalid_input' };
    if (!write.ok && isRevisionConflict(write.error)) {
      let fresh: Awaited<ReturnType<OwnerPrefsClient['getPrefs']>>;
      try {
        fresh = await options.api.getPrefs();
      } catch {
        return { status: 'failed', reason: 'api' };
      }
      if (!fresh.ok) return { status: 'failed', reason: 'api' };
      revision = fresh.data.revision;
      try {
        write = await putPrefs(nextPrefs, revision);
      } catch {
        return { status: 'failed', reason: 'api' };
      }
      if (write === null) return { status: 'failed', reason: 'invalid_input' };
    }
    if (!write.ok) return { status: 'failed', reason: 'api' };
    revision = write.data.revision;
    prefsStale = false;
    return local.save(conditions);
  };

  return { read, save, hydrate };
};
