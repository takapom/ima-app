export type BudgetOption = 'cheap' | 'normal' | 'any';
export type ConditionScope = 'thread' | 'saved';

export type JourneyConditions = {
  readonly budget: BudgetOption;
};

export const createDefaultJourneyConditions = (): JourneyConditions => ({
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
