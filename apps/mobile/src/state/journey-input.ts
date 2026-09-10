export const MAX_QUERY_LENGTH = 500 as const;
export const MAX_CHIPS = 4 as const;

export const DEFAULT_SUGGESTIONS = ['食後', '静か', '徒歩10分', '終電まで'] as const;

export type StationSupport = 'supported' | 'unsupported' | 'unknown';
export type BudgetOption = 'cheap' | 'normal' | 'any';
export type ConditionScope = 'thread' | 'saved';

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

const queryChipCandidates = (query: string): string[] => {
  const candidates: string[] = [];
  const walk = query.match(/徒歩\s*(\d+)\s*分/);
  if (walk) candidates.push(`徒歩${walk[1]}分`);
  if (/終電/.test(query)) candidates.push('終電まで');
  if (/食後|ご飯|食べ/.test(query)) candidates.push('食後');
  if (/静か/.test(query)) candidates.push('静か');
  if (/雨|屋内/.test(query)) candidates.push('屋内');
  if (/甘い|スイーツ|チョコ/.test(query)) candidates.push('甘いもの');
  if (/座れ/.test(query)) candidates.push('座れる');
  if (/近い|すぐ/.test(query)) candidates.push('近い');
  return candidates;
};

export const preferenceChipLabels = (conditions: JourneyConditions): string[] => {
  const labels: string[] = [];
  if (conditions.stationLabel.trim().length > 0) {
    labels.push(`終電 ${conditions.stationLabel.trim()}`);
  }
  if (conditions.maxWalkMinutes !== null) {
    labels.push(`徒歩${conditions.maxWalkMinutes}分`);
  }
  if (conditions.budget !== 'any') {
    labels.push(budgetLabel(conditions.budget));
  }
  return labels;
};

export const conditionChangesForChip = (
  conditions: JourneyConditions,
  label: string,
): Partial<JourneyConditions> => {
  const stationLabel = conditions.stationLabel.trim();
  if (stationLabel.length > 0 && label === `終電 ${stationLabel}`) {
    return { stationLabel: '', stationSupport: 'unknown' };
  }
  if (conditions.maxWalkMinutes !== null && label === `徒歩${conditions.maxWalkMinutes}分`) {
    return { maxWalkMinutes: null };
  }
  if (conditions.budget !== 'any' && label === budgetLabel(conditions.budget)) {
    return { budget: 'any' };
  }
  return {};
};

const duplicateChip = (label: string, existing: readonly string[]): boolean =>
  existing.some(
    (item) =>
      item === label ||
      (label.startsWith('徒歩') && item.startsWith('徒歩')) ||
      (label === '終電まで' && item.startsWith('終電 ')),
  );

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

export const stationSupportLabel = (support: StationSupport): string => {
  if (support === 'supported') return '対応駅';
  if (support === 'unsupported') return '未対応';
  return '対応確認待ち';
};
