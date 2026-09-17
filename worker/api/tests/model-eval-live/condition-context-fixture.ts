export type ModelEvalConditionFixtureProfile = 'condition-change' | 'mixed-intent';

export const isConditionFixtureProfile = (
  profile: string,
): profile is ModelEvalConditionFixtureProfile =>
  profile === 'condition-change' || profile === 'mixed-intent';

export const searchQueryFor = (profile: string): string =>
  profile === 'condition-change'
    ? '静かな店'
    : profile === 'mixed-intent'
      ? '静かで予算内の店'
      : profile === 'prompt-injection'
        ? '川辺食堂'
        : '静かなカフェ';

export const candidateLimitFor = (profile: string): number =>
  isConditionFixtureProfile(profile) ? 1 : 3;

export const assertConditionProjection = (profile: string, budget: string | null): void => {
  if (isConditionFixtureProfile(profile) && budget !== 'normal') {
    throw new Error('M25_FIXTURE_BUDGET_CONTEXT_MISSING');
  }
};
