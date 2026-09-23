import type { Preferences } from '@ima/contracts';
import {
  createDefaultJourneyConditions,
  type JourneyConditions,
} from '@mobile/preferences/state/conditions';
import type { SqliteStore } from '@mobile/platform/sqlite/types';

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
  areaText: null,
  budget: null,
});

const fallbackFor = (fallback: JourneyConditions | undefined): JourneyConditions =>
  fallback ?? createDefaultJourneyConditions();

/** Projects stored settings onto the caller's in-memory fallback. */
export const journeyConditionsForPreferences = (
  persisted: Pick<Preferences, 'budget'> | null,
  fallback?: JourneyConditions,
): JourneyConditions => {
  const base = fallbackFor(fallback);
  if (persisted === null) return base;
  return { ...base, budget: persisted.budget ?? 'any' };
};

export const hasPersistedJourneyPreferenceChange = (changes: Partial<JourneyConditions>): boolean =>
  Object.prototype.hasOwnProperty.call(changes, 'budget');

const preferencesFor = (current: Preferences, conditions: JourneyConditions): Preferences => ({
  areaText: current.areaText,
  budget: conditions.budget,
});

export const isValidJourneyConditions = (conditions: JourneyConditions): boolean =>
  conditions.budget === 'cheap' || conditions.budget === 'normal' || conditions.budget === 'any';

const preferencesEqual = (left: Preferences, right: Preferences): boolean =>
  left.areaText === right.areaText && left.budget === right.budget;

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
      const current: Preferences =
        persisted === null
          ? emptyPreferences()
          : { areaText: persisted.areaText, budget: persisted.budget };
      const next = preferencesFor(current, conditions);
      if (persisted !== null && preferencesEqual(current, next)) {
        return { status: 'unchanged', preferences: next };
      }
      storage.savePreferences(next);
      return { status: 'saved', preferences: next };
    } catch {
      return { status: 'failed', reason: 'storage_unavailable' };
    }
  };

  return { read, save };
};
