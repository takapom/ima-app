export const MAX_QUERY_LENGTH = 500 as const;
export const MAX_STATION_LABEL_LENGTH = 160 as const;
export const MAX_CHIPS = 4 as const;

/** Walking and last-train terms stay out until those providers are connected. */
export const DEFAULT_SUGGESTIONS = ['食後', '静か', '屋内', '甘いもの'] as const;

/** Only `unknown` is produced while no station resolver is connected. */
export type StationSupport = 'supported' | 'unsupported' | 'unknown';
export type BudgetOption = 'cheap' | 'normal' | 'any';
export type ConditionScope = 'thread' | 'saved';

/**
 * `stationLabel`, `stationSupport` and `maxWalkMinutes` are kept as the shape of the
 * stored settings contract, not as editable conditions: no editor writes them and the
 * request boundary clears them while last-train and walking-route evidence is absent.
 * Reconnecting those providers restores the editors rather than reshaping storage.
 */
export type JourneyConditions = {
  readonly stationLabel: string;
  readonly stationSupport: StationSupport;
  readonly maxWalkMinutes: number | null;
  readonly budget: BudgetOption;
};

export const createDefaultJourneyConditions = (): JourneyConditions => ({
  stationLabel: '',
  stationSupport: 'unknown',
  maxWalkMinutes: null,
  budget: 'any',
});

const normalizedTerm = (term: string): string => term.trim().replace(/\s+/g, ' ');

export const uniqueTerms = (terms: readonly string[], limit: number = MAX_CHIPS): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const label = normalizedTerm(term);
    if (label.length === 0 || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
    if (result.length >= limit) break;
  }
  return result;
};

export const appendSuggestion = (
  value: string,
  suggestion: string,
  maxLength: number = MAX_QUERY_LENGTH,
): string => {
  const label = normalizedTerm(suggestion);
  if (label.length === 0 || value.includes(label)) return value;
  if (value.trim().length === 0) return label.length <= maxLength ? label : value;
  const next = /[、,，\s]$/.test(value) ? `${value}${label}` : `${value}、${label}`;
  return next.length <= maxLength ? next : value;
};

export const suggestionsFor = (
  draft: string,
  pool: readonly string[] = DEFAULT_SUGGESTIONS,
): string[] => {
  const text = draft.trim();
  const candidates = uniqueTerms(pool, MAX_CHIPS * 2).filter((term) => !text.includes(term));
  if (text.length === 0) return candidates.slice(0, MAX_CHIPS);

  const fragment = text.split(/[、,，\s]+/).at(-1) ?? text;
  const matches = candidates.filter((term) => term.includes(fragment) || term.startsWith(fragment));
  return uniqueTerms([...matches, ...candidates], MAX_CHIPS);
};

/**
 * Walking and last-train phrases are not turned into chips: the connected providers
 * cannot evidence them, so a chip would imply a filter that is never applied.
 */
const queryChipCandidates = (query: string): string[] => {
  const candidates: string[] = [];
  if (/食後|ご飯|食べ/.test(query)) candidates.push('食後');
  if (/静か/.test(query)) candidates.push('静か');
  if (/雨|屋内/.test(query)) candidates.push('屋内');
  if (/甘い|スイーツ|チョコ/.test(query)) candidates.push('甘いもの');
  if (/座れ/.test(query)) candidates.push('座れる');
  return candidates;
};

/** Only conditions the connected providers can actually apply become chips. */
export const preferenceChipLabels = (conditions: JourneyConditions): string[] =>
  conditions.budget === 'any' ? [] : [budgetLabel(conditions.budget)];

export const conditionChangesForChip = (
  conditions: JourneyConditions,
  label: string,
): Partial<JourneyConditions> =>
  conditions.budget !== 'any' && label === budgetLabel(conditions.budget) ? { budget: 'any' } : {};

const duplicateChip = (label: string, existing: readonly string[]): boolean =>
  existing.some((item) => item === label);

export const mergeChipLabels = (
  preferenceLabels: readonly string[],
  query: string,
  suppressedLabels: readonly string[] = [],
): string[] => {
  const result: string[] = [];
  const suppressed = new Set(suppressedLabels.map(normalizedTerm));
  for (const label of [...preferenceLabels, ...queryChipCandidates(query)]) {
    const normalized = normalizedTerm(label);
    if (normalized.length === 0 || suppressed.has(normalized) || duplicateChip(normalized, result))
      continue;
    result.push(normalized);
    if (result.length >= MAX_CHIPS) break;
  }
  return result;
};

export const budgetLabel = (budget: BudgetOption): string => {
  if (budget === 'cheap') return '安め';
  if (budget === 'normal') return '普通';
  return '予算指定なし';
};
