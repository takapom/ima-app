import { describe, expect, it } from 'vitest';
import {
  appendSuggestion,
  conditionChangesForChip,
  createDefaultJourneyConditions,
  mergeChipLabels,
  suggestionsFor,
  stationSupportLabel,
  uniqueTerms,
} from './journey-input';

describe('journey input helpers', () => {
  it('adds a suggestion without submitting and suppresses an existing term', () => {
    expect(appendSuggestion('恵比寿で', '静か')).toBe('恵比寿で、静か');
    expect(appendSuggestion('恵比寿で、静か', '静か')).toBe('恵比寿で、静か');
    expect(appendSuggestion('恵比寿で、', '静か')).toBe('恵比寿で、静か');
    const nearLimit = 'あ'.repeat(499);
    expect(appendSuggestion(nearLimit, '静か')).toBe(nearLimit);
  });

  it('keeps at most four unique candidate terms', () => {
    expect(uniqueTerms(['静か', '静か', '食後', '徒歩10分', '終電まで', '雨で屋内'])).toEqual([
      '静か',
      '食後',
      '徒歩10分',
      '終電まで',
    ]);
    expect(suggestionsFor('静', ['静か', '静か', '食後', '徒歩10分', '終電まで'])).toEqual([
      '静か',
      '食後',
      '徒歩10分',
      '終電まで',
    ]);
  });

  it('deduplicates preference and query chips by meaning', () => {
    expect(mergeChipLabels(['終電 渋谷', '徒歩10分', '普通'], '静か。徒歩10分。終電まで')).toEqual([
      '終電 渋谷',
      '徒歩10分',
      '普通',
      '静か',
    ]);
    expect(mergeChipLabels([], '歩いて行きたい')).toEqual([]);
  });

  it('does not invent a location while creating editable conditions', () => {
    expect(createDefaultJourneyConditions()).toEqual({
      stationLabel: '',
      stationSupport: 'unknown',
      maxWalkMinutes: null,
      budget: 'any',
    });
    expect(stationSupportLabel('supported')).toBe('対応駅');
    expect(stationSupportLabel('unsupported')).toBe('未対応');
    expect(stationSupportLabel('unknown')).toBe('対応確認待ち');
  });

  it('turns a removed preference chip into an effective condition change', () => {
    const conditions = {
      ...createDefaultJourneyConditions(),
      stationLabel: '渋谷',
      maxWalkMinutes: 10,
      budget: 'normal' as const,
    };

    expect(conditionChangesForChip(conditions, '終電 渋谷')).toEqual({
      stationLabel: '',
      stationSupport: 'unknown',
    });
    expect(conditionChangesForChip(conditions, '徒歩10分')).toEqual({ maxWalkMinutes: null });
    expect(conditionChangesForChip(conditions, '普通')).toEqual({ budget: 'any' });
  });
});
