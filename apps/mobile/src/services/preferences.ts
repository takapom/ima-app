import type { Preferences } from '@ima/contracts';
import {
  createDefaultJourneyConditions,
  MAX_STATION_LABEL_LENGTH,
  type JourneyConditions,
} from '../state/journey-input';
import type { SqliteStore } from './sqlite/types';

export type JourneyPreferencesStorage = Pick<SqliteStore, 'readPreferences' | 'savePreferences'>;

export type JourneyPreferencesReadResult =
  | {
      readonly status: 'available';
      readonly source: 'stored' | 'default';
      readonly conditions: JourneyConditions;
      readonly stale?: true;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'storage_unavailable';
      readonly conditions: JourneyConditions;
    };

export type JourneyPreferencesSaveResult =
  | {
      readonly status: 'saved' | 'unchanged';
      /** Only the public Preferences fields are returned; local stationLabel stays device-only. */
      readonly preferences: Preferences;
    }
  | {
      readonly status: 'failed';
      readonly reason: 'storage_unavailable' | 'invalid_input' | 'api';
    };

export type JourneyPreferencesLocalService = {
  readonly read: (fallback?: JourneyConditions) => JourneyPreferencesReadResult;
  readonly save: (conditions: JourneyConditions) => JourneyPreferencesSaveResult;
};

export type JourneyPreferencesService = {
  readonly read: (fallback?: JourneyConditions) => JourneyPreferencesReadResult;
  readonly save: (
    conditions: JourneyConditions,
  ) => JourneyPreferencesSaveResult | Promise<JourneyPreferencesSaveResult>;
  readonly hydrate?: () => Promise<unknown>;
};

const emptyPreferences = (): Preferences => ({
  homeStationRef: null,
  maxWalkMinutes: null,
  minimumStayMinutes: null,
  areaText: null,
  budget: null,
});

type StoredPreferences = Pick<
  Preferences,
  'homeStationRef' | 'maxWalkMinutes' | 'minimumStayMinutes' | 'areaText' | 'budget'
> & {
  readonly stationLabel?: string | null;
};

const fallbackFor = (fallback: JourneyConditions | undefined): JourneyConditions =>
  fallback ?? createDefaultJourneyConditions();

/** Projects device-only settings onto the caller's in-memory fallback. */
export const journeyConditionsForPreferences = (
  persisted:
    | (Pick<Preferences, 'maxWalkMinutes' | 'budget'> & {
        readonly stationLabel?: string | null;
      })
    | null,
  fallback?: JourneyConditions,
): JourneyConditions => {
  const base = fallbackFor(fallback);
  if (persisted === null) return base;
  const hasStationLabel = Object.prototype.hasOwnProperty.call(persisted, 'stationLabel');
  return {
    ...base,
    stationLabel: hasStationLabel ? (persisted.stationLabel ?? '') : base.stationLabel,
    stationSupport: hasStationLabel ? 'unknown' : base.stationSupport,
    maxWalkMinutes: persisted.maxWalkMinutes,
    budget: persisted.budget ?? 'any',
  };
};

export const hasPersistedJourneyPreferenceChange = (changes: Partial<JourneyConditions>): boolean =>
  Object.prototype.hasOwnProperty.call(changes, 'stationLabel') ||
  Object.prototype.hasOwnProperty.call(changes, 'maxWalkMinutes') ||
  Object.prototype.hasOwnProperty.call(changes, 'budget');

const preferencesFor = (
  current: StoredPreferences,
  conditions: JourneyConditions,
): StoredPreferences & { readonly stationLabel: string } => ({
  homeStationRef: current.homeStationRef,
  maxWalkMinutes: conditions.maxWalkMinutes,
  minimumStayMinutes: current.minimumStayMinutes,
  areaText: current.areaText,
  budget: conditions.budget,
  stationLabel: conditions.stationLabel,
});

export const isValidJourneyConditions = (conditions: JourneyConditions): boolean =>
  typeof conditions.stationLabel === 'string' &&
  conditions.stationLabel.length <= MAX_STATION_LABEL_LENGTH &&
  (conditions.maxWalkMinutes === null ||
    (Number.isInteger(conditions.maxWalkMinutes) &&
      conditions.maxWalkMinutes >= 1 &&
      conditions.maxWalkMinutes <= 180)) &&
  (conditions.budget === 'cheap' || conditions.budget === 'normal' || conditions.budget === 'any');

const normalizedStationLabel = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.length === 0 ? null : value;

const preferencesEqual = (left: StoredPreferences, right: StoredPreferences): boolean =>
  left.homeStationRef === right.homeStationRef &&
  left.maxWalkMinutes === right.maxWalkMinutes &&
  left.minimumStayMinutes === right.minimumStayMinutes &&
  left.areaText === right.areaText &&
  left.budget === right.budget &&
  normalizedStationLabel(left.stationLabel) === normalizedStationLabel(right.stationLabel);

const publicPreferencesFor = (preferences: StoredPreferences): Preferences => ({
  homeStationRef: preferences.homeStationRef,
  maxWalkMinutes: preferences.maxWalkMinutes ?? null,
  minimumStayMinutes: preferences.minimumStayMinutes ?? null,
  areaText: preferences.areaText ?? null,
  budget: preferences.budget ?? null,
});

export const createJourneyPreferencesService = (
  storage?: JourneyPreferencesStorage,
): JourneyPreferencesLocalService => {
  const read = (fallback?: JourneyConditions): JourneyPreferencesReadResult => {
    const base = fallbackFor(fallback);
    if (storage === undefined) {
      return { status: 'unavailable', reason: 'storage_unavailable', conditions: base };
    }
    try {
      const persisted = storage.readPreferences();
      return {
        status: 'available',
        source: persisted === null ? 'default' : 'stored',
        conditions: journeyConditionsForPreferences(persisted, base),
      };
    } catch {
      return { status: 'unavailable', reason: 'storage_unavailable', conditions: base };
    }
  };

  const save = (conditions: JourneyConditions): JourneyPreferencesSaveResult => {
    if (!isValidJourneyConditions(conditions)) return { status: 'failed', reason: 'invalid_input' };
    if (storage === undefined) return { status: 'failed', reason: 'storage_unavailable' };
    try {
      const persisted = storage.readPreferences();
      const current: StoredPreferences = persisted === null ? emptyPreferences() : persisted;
      const next = preferencesFor(current, conditions);
      if (persisted !== null && preferencesEqual(current, next)) {
        return { status: 'unchanged', preferences: publicPreferencesFor(next) };
      }
      storage.savePreferences(next);
      return { status: 'saved', preferences: publicPreferencesFor(next) };
    } catch {
      return { status: 'failed', reason: 'storage_unavailable' };
    }
  };

  return { read, save };
};
