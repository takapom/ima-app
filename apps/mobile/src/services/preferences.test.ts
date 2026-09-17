import { describe, expect, it } from 'vitest';
import {
  journeyPreferenceChangeFor,
  journeyPreferenceTransitionFor,
} from '@mobile/hooks/useJourneyPreferences';
import {
  createJourneyPreferencesService,
  hasPersistedJourneyPreferenceChange,
  journeyConditionsForPreferences,
  type JourneyPreferencesStorage,
  type JourneyPreferencesSaveResult,
} from '@mobile/services/preferences';
import type { SqlitePreferences, SqlitePreferencesInput } from '@mobile/services/sqlite/types';
import type { JourneyConditions } from '@mobile/state/journey-input';

const fallback: JourneyConditions = {
  stationLabel: '渋谷',
  stationSupport: 'unknown',
  maxWalkMinutes: 15,
  budget: 'normal',
};

const stored = (overrides: Partial<SqlitePreferences> = {}): SqlitePreferences => ({
  homeStationRef: 'station-ebisu',
  maxWalkMinutes: 20,
  minimumStayMinutes: 30,
  areaText: '恵比寿',
  budget: 'cheap',
  stationLabel: null,
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
      current = {
        ...preferences,
        stationLabel:
          preferences.stationLabel === undefined
            ? (current?.stationLabel ?? null)
            : preferences.stationLabel.length === 0
              ? null
              : preferences.stationLabel,
        updatedAt: '2026-09-11T02:01:00.000Z',
      };
      saved = preferences;
    },
    saved: () => saved,
  };
};

describe('journey preferences service', () => {
  it('treats a stored null station label as an empty editable value', () => {
    const service = createJourneyPreferencesService(storageFor(stored()));

    expect(service.read(fallback)).toEqual({
      status: 'available',
      source: 'stored',
      conditions: {
        ...fallback,
        stationLabel: '',
        stationSupport: 'unknown',
        maxWalkMinutes: 20,
        budget: 'cheap',
      },
    });
  });

  it('restores a persisted station label without inventing canonical station support', () => {
    const service = createJourneyPreferencesService(storageFor(stored({ stationLabel: '恵比寿' })));

    expect(service.read(fallback).conditions).toEqual({
      ...fallback,
      stationLabel: '恵比寿',
      stationSupport: 'unknown',
      maxWalkMinutes: 20,
      budget: 'cheap',
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
    expect(
      journeyConditionsForPreferences({ maxWalkMinutes: null, budget: null }, fallback),
    ).toEqual({ ...fallback, maxWalkMinutes: null, budget: 'any' });
  });

  it('maps a persisted null station label to empty without fabricating a station reference', () => {
    expect(
      journeyConditionsForPreferences(
        { maxWalkMinutes: null, budget: null, stationLabel: null },
        fallback,
      ),
    ).toEqual({
      ...fallback,
      stationLabel: '',
      stationSupport: 'unknown',
      maxWalkMinutes: null,
      budget: 'any',
    });
  });

  it('read-modify-writes only the editable fields and preserves other preferences', () => {
    const storage = storageFor(stored());
    const service = createJourneyPreferencesService(storage);

    const result = service.save({
      ...fallback,
      stationLabel: '新宿',
      maxWalkMinutes: 10,
      budget: 'normal',
    });

    expect(result).toEqual({
      status: 'saved',
      preferences: {
        homeStationRef: 'station-ebisu',
        // No editor writes a walking limit while walking-route evidence is absent,
        // so a save clears it rather than persisting an unreachable condition.
        maxWalkMinutes: null,
        minimumStayMinutes: 30,
        areaText: '恵比寿',
        budget: 'normal',
      },
    });
    expect(storage.saved()).toEqual(
      result.status === 'saved' ? { ...result.preferences, stationLabel: '新宿' } : null,
    );
  });

  it('clears a stored walking limit the editor can no longer reach', () => {
    const storage = storageFor(
      stored({ maxWalkMinutes: 15, budget: 'normal', stationLabel: fallback.stationLabel }),
    );
    const service = createJourneyPreferencesService(storage);

    expect(service.save(fallback)).toEqual({
      status: 'saved',
      preferences: {
        homeStationRef: 'station-ebisu',
        maxWalkMinutes: null,
        minimumStayMinutes: 30,
        areaText: '恵比寿',
        budget: 'normal',
      },
    });
    expect(storage.saved()).toMatchObject({ maxWalkMinutes: null });
  });

  it('does not write when persisted values are unchanged', () => {
    const storage = storageFor(
      stored({ maxWalkMinutes: null, budget: 'normal', stationLabel: fallback.stationLabel }),
    );
    const service = createJourneyPreferencesService(storage);

    expect(service.save(fallback)).toEqual({
      status: 'unchanged',
      preferences: {
        homeStationRef: 'station-ebisu',
        maxWalkMinutes: null,
        minimumStayMinutes: 30,
        areaText: '恵比寿',
        budget: 'normal',
      },
    });
    expect(storage.saved()).toBeNull();
  });

  it('rejects invalid editable values without reading or writing', () => {
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
      createJourneyPreferencesService(storage).save({ ...fallback, maxWalkMinutes: 0 }),
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
    expect(saveFailure.save({ ...fallback, budget: 'cheap' })).toEqual({
      status: 'failed',
      reason: 'storage_unavailable',
    });
  });

  it('identifies station, walk, and budget changes as persisted changes', () => {
    expect(hasPersistedJourneyPreferenceChange({ stationLabel: '池袋' })).toBe(true);
    expect(hasPersistedJourneyPreferenceChange({ stationSupport: 'unknown' })).toBe(false);
    expect(hasPersistedJourneyPreferenceChange({ maxWalkMinutes: 5 })).toBe(true);
    expect(hasPersistedJourneyPreferenceChange({ budget: 'cheap' })).toBe(true);
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
      { maxWalkMinutes: 5 },
      undefined,
    );

    expect(first.savedConditions).toEqual({ ...fallback, budget: 'cheap' });
    expect(second.savedConditions).toEqual({ ...fallback, budget: 'cheap', maxWalkMinutes: 5 });
  });

  it('does not apply an editable saved value when persistence fails', () => {
    const failure = (): JourneyPreferencesSaveResult => ({
      status: 'failed',
      reason: 'storage_unavailable',
    });
    expect(journeyPreferenceChangeFor('saved', fallback, { maxWalkMinutes: 5 }, failure)).toEqual({
      applied: false,
      saveResult: { status: 'failed', reason: 'storage_unavailable' },
      notice: '条件を保存できませんでした。もう一度試してください。',
    });
  });

  it('persists a saved station label without a notice when storage is available', () => {
    let received: string | undefined;
    const saved = (conditions: JourneyConditions): JourneyPreferencesSaveResult => {
      received = conditions.stationLabel;
      return {
        status: 'saved',
        preferences: {
          homeStationRef: null,
          maxWalkMinutes: 15,
          minimumStayMinutes: null,
          areaText: null,
          budget: 'normal',
        },
      };
    };
    expect(journeyPreferenceChangeFor('saved', fallback, { stationLabel: '池袋' }, saved)).toEqual({
      applied: true,
      saveResult: {
        status: 'saved',
        preferences: {
          homeStationRef: null,
          maxWalkMinutes: 15,
          minimumStayMinutes: null,
          areaText: null,
          budget: 'normal',
        },
      },
      notice: null,
    });
    expect(received).toBe('池袋');
  });

  it('reports that a saved station label is session-only without storage', () => {
    expect(
      journeyPreferenceChangeFor('saved', fallback, { stationLabel: '池袋' }, undefined),
    ).toEqual({
      applied: true,
      saveResult: null,
      notice: '駅名は端末に保存されません。',
    });
  });

  it('rejects a station label above the shared app bound before storage access', () => {
    let reads = 0;
    const storage: JourneyPreferencesStorage = {
      readPreferences: () => {
        reads += 1;
        return stored();
      },
      savePreferences: () => undefined,
    };
    expect(
      createJourneyPreferencesService(storage).save({
        ...fallback,
        stationLabel: 'x'.repeat(161),
      }),
    ).toEqual({ status: 'failed', reason: 'invalid_input' });
    expect(reads).toBe(0);
  });

  it('keeps thread-scope edits out of saved preference state', () => {
    const saved = (): JourneyPreferencesSaveResult => ({
      status: 'saved',
      preferences: {
        homeStationRef: null,
        maxWalkMinutes: 15,
        minimumStayMinutes: null,
        areaText: null,
        budget: 'normal',
      },
    });
    expect(journeyPreferenceChangeFor('thread', fallback, { stationLabel: '池袋' }, saved)).toEqual(
      {
        applied: true,
        saveResult: null,
        notice: null,
      },
    );
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
