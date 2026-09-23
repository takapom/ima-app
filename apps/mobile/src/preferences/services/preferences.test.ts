import { describe, expect, it } from 'vitest';
import {
  journeyPreferenceChangeFor,
  journeyPreferenceTransitionFor,
} from '@mobile/preferences/hooks/useJourneyPreferences';
import {
  createJourneyPreferencesService,
  hasPersistedJourneyPreferenceChange,
  journeyConditionsForPreferences,
  type JourneyPreferencesStorage,
  type JourneyPreferencesSaveResult,
} from '@mobile/preferences/services/preferences';
import type { SqlitePreferences, SqlitePreferencesInput } from '@mobile/platform/sqlite/types';
import type { JourneyConditions } from '@mobile/preferences/state/conditions';

const fallback: JourneyConditions = {
  budget: 'normal',
};

const stored = (overrides: Partial<SqlitePreferences> = {}): SqlitePreferences => ({
  areaText: '恵比寿',
  budget: 'cheap',
  updatedAt: '2026-09-11T02:00:00.000Z',
  ...overrides,
});

const storageFor = (
  initial: SqlitePreferences | null,
  options: { readonly readThrows?: boolean; readonly saveThrows?: boolean } = {},
): JourneyPreferencesStorage & {
  readonly saved: () => SqlitePreferencesInput | null;
} => {
  let current = initial;
  let saved: SqlitePreferencesInput | null = null;
  return {
    readPreferences: () => {
      if (options.readThrows) throw new Error('read failed');
      return current;
    },
    savePreferences: (preferences) => {
      if (options.saveThrows) throw new Error('save failed');
      current = { ...preferences, updatedAt: '2026-09-11T02:01:00.000Z' };
      saved = preferences;
    },
    saved: () => saved,
  };
};

describe('journey preferences service', () => {
  it('restores the stored budget', () => {
    const service = createJourneyPreferencesService(storageFor(stored()));

    expect(service.read(fallback)).toEqual({
      status: 'available',
      source: 'stored',
      conditions: { budget: 'cheap' },
    });
  });

  it('uses fallback conditions when no preference row exists', () => {
    const service = createJourneyPreferencesService(storageFor(null));

    expect(service.read(fallback)).toEqual({
      status: 'available',
      source: 'default',
      conditions: fallback,
    });
  });

  it('maps a null persisted budget to the editable any option', () => {
    expect(journeyConditionsForPreferences({ budget: null }, fallback)).toEqual({ budget: 'any' });
  });

  it('read-modify-writes only the budget and preserves the stored area text', () => {
    const storage = storageFor(stored());
    const service = createJourneyPreferencesService(storage);

    const result = service.save({ budget: 'normal' });

    expect(result).toEqual({
      status: 'saved',
      preferences: { areaText: '恵比寿', budget: 'normal' },
    });
    expect(storage.saved()).toEqual({ areaText: '恵比寿', budget: 'normal' });
  });

  it('does not write when persisted values are unchanged', () => {
    const storage = storageFor(stored({ budget: 'normal' }));
    const service = createJourneyPreferencesService(storage);

    expect(service.save(fallback)).toEqual({
      status: 'unchanged',
      preferences: { areaText: '恵比寿', budget: 'normal' },
    });
    expect(storage.saved()).toBeNull();
  });

  it('rejects an invalid budget without reading or writing', () => {
    let reads = 0;
    let writes = 0;
    const storage: JourneyPreferencesStorage = {
      readPreferences: () => {
        reads += 1;
        return stored();
      },
      savePreferences: () => {
        writes += 1;
      },
    };

    expect(
      createJourneyPreferencesService(storage).save({
        budget: 'luxury' as JourneyConditions['budget'],
      }),
    ).toEqual({ status: 'failed', reason: 'invalid_input' });
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it('reports read and write failures instead of reporting success', () => {
    const readFailure = createJourneyPreferencesService(storageFor(stored(), { readThrows: true }));
    expect(readFailure.read(fallback)).toEqual({
      status: 'unavailable',
      reason: 'storage_unavailable',
      conditions: fallback,
    });
    expect(readFailure.save(fallback)).toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });

    const saveFailure = createJourneyPreferencesService(storageFor(stored(), { saveThrows: true }));
    expect(saveFailure.save({ budget: 'any' })).toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
  });

  it('identifies a budget change as a persisted change', () => {
    expect(hasPersistedJourneyPreferenceChange({ budget: 'cheap' })).toBe(true);
    expect(hasPersistedJourneyPreferenceChange({})).toBe(false);
  });

  it('keeps edits in memory with an explicit notice when SQLite is not injected', () => {
    expect(journeyPreferenceChangeFor('saved', fallback, { budget: 'cheap' }, undefined)).toEqual({
      applied: true,
      saveResult: null,
      notice: '条件は端末に保存されません。',
    });
  });

  it('carries successive memory edits into the next saved condition state', () => {
    const first = journeyPreferenceTransitionFor('saved', fallback, { budget: 'cheap' }, undefined);
    const second = journeyPreferenceTransitionFor(
      'saved',
      first.savedConditions,
      { budget: 'any' },
      undefined,
    );

    expect(first.savedConditions).toEqual({ budget: 'cheap' });
    expect(second.savedConditions).toEqual({ budget: 'any' });
  });

  it('does not apply an editable saved value when persistence fails', () => {
    const failure = (): JourneyPreferencesSaveResult => ({
      status: 'failed',
      reason: 'storage_unavailable',
    });
    expect(journeyPreferenceChangeFor('saved', fallback, { budget: 'cheap' }, failure)).toEqual({
      applied: false,
      saveResult: { status: 'failed', reason: 'storage_unavailable' },
      notice: '条件を保存できませんでした。もう一度試してください。',
    });
  });

  it('persists a saved budget without a notice when storage is available', () => {
    let received: JourneyConditions['budget'] | undefined;
    const saved = (conditions: JourneyConditions): JourneyPreferencesSaveResult => {
      received = conditions.budget;
      return {
        status: 'saved',
        preferences: { areaText: null, budget: 'cheap' },
      };
    };
    expect(journeyPreferenceChangeFor('saved', fallback, { budget: 'cheap' }, saved)).toEqual({
      applied: true,
      saveResult: {
        status: 'saved',
        preferences: { areaText: null, budget: 'cheap' },
      },
      notice: null,
    });
    expect(received).toBe('cheap');
  });

  it('keeps thread-scope edits out of saved preference state', () => {
    const saved = (): JourneyPreferencesSaveResult => ({
      status: 'saved',
      preferences: { areaText: null, budget: 'normal' },
    });
    expect(journeyPreferenceChangeFor('thread', fallback, { budget: 'cheap' }, saved)).toEqual({
      applied: true,
      saveResult: null,
      notice: null,
    });
  });

  it('keeps settings unavailable when no storage was injected', () => {
    const service = createJourneyPreferencesService();

    expect(service.read(fallback)).toEqual({
      status: 'unavailable',
      reason: 'storage_unavailable',
      conditions: fallback,
    });
    expect(service.save(fallback)).toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
  });
});
