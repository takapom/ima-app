export const MAX_STATION_LABEL_LENGTH = 160 as const;

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

/** Only conditions the connected providers can actually apply become chips. */
export const preferenceChipLabels = (conditions: JourneyConditions): string[] =>
  conditions.budget === 'any' ? [] : [budgetLabel(conditions.budget)];

export const conditionChangesForChip = (
  conditions: JourneyConditions,
  label: string,
): Partial<JourneyConditions> =>
  conditions.budget !== 'any' && label === budgetLabel(conditions.budget) ? { budget: 'any' } : {};

export const budgetLabel = (budget: BudgetOption): string => {
  if (budget === 'cheap') return '安め';
  if (budget === 'normal') return '普通';
  return '予算指定なし';
};
