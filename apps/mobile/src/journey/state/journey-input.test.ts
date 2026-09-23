import { describe, expect, it } from 'vitest';
import {
  appendSuggestion,
  mergeChipLabels,
  suggestionsFor,
  uniqueTerms,
} from '@mobile/journey/state/journey-input';
import {
  conditionChangesForChip,
  createDefaultJourneyConditions,
  preferenceChipLabels,
} from '@mobile/preferences/state/conditions';

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
    expect(mergeChipLabels(['普通'], '静か。甘いもの')).toEqual(['普通', '静か', '甘いもの']);
    expect(mergeChipLabels([], '歩いて行きたい')).toEqual([]);
  });

  it('never chips a walking or last-train phrase the providers cannot apply', () => {
    expect(mergeChipLabels([], '静か。徒歩10分。終電まで')).toEqual(['静か']);
    expect(preferenceChipLabels(createDefaultJourneyConditions())).toEqual([]);
  });

  it('does not invent a location while creating editable conditions', () => {
    expect(createDefaultJourneyConditions()).toEqual({
      budget: 'any',
    });
  });

  it('turns a removed preference chip into an effective condition change', () => {
    const conditions = {
      ...createDefaultJourneyConditions(),
      budget: 'normal' as const,
    };

    expect(conditionChangesForChip(conditions, '普通')).toEqual({ budget: 'any' });
    expect(conditionChangesForChip(conditions, '徒歩10分')).toEqual({});
    expect(conditionChangesForChip(conditions, '終電 渋谷')).toEqual({});
  });
});
