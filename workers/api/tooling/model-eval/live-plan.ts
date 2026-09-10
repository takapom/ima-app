import type { EvaluationCase, ScenarioId } from './types';

export type LiveEvaluationProfile = 'new-search' | 'reason' | 'continuity';

export type LiveEvaluationPrelude = {
  readonly text: string;
  readonly source: 'scenario' | 'synthetic';
};

export type LiveEvaluationTurnPlan = {
  readonly profile: LiveEvaluationProfile;
  readonly prelude: LiveEvaluationPrelude | null;
  readonly targetTexts: readonly [string];
};

export type LiveEvaluationTurnPlanResult =
  | { readonly ok: true; readonly plan: LiveEvaluationTurnPlan }
  | {
      readonly ok: false;
      readonly code: 'LIVE_PROFILE_UNAVAILABLE' | 'LIVE_TURN_SHAPE_UNSUPPORTED';
    };

const profileFor: Partial<Record<ScenarioId, LiveEvaluationProfile>> = {
  'new-search': 'new-search',
  reason: 'reason',
  continuity: 'continuity',
};

/** Returns the only scenarios that have an executable live turn shape. */
export const liveEvaluationProfileFor = (
  scenario: Pick<EvaluationCase, 'id'>,
): LiveEvaluationProfile | null => profileFor[scenario.id] ?? null;

/**
 * Builds the formal same-DO plan. Prelude responses are state setup and are
 * never counted as an evaluation repeat.
 */
export const createLiveEvaluationTurnPlan = (
  evaluationCase: EvaluationCase,
): LiveEvaluationTurnPlanResult => {
  const profile = liveEvaluationProfileFor(evaluationCase);
  if (profile === null) return { ok: false, code: 'LIVE_PROFILE_UNAVAILABLE' };
  const [first, second, ...extra] = evaluationCase.userTurns;
  if (extra.length > 0 || first === undefined) {
    return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
  }
  if (profile === 'new-search') {
    if (second !== undefined) return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
    return { ok: true, plan: { profile, prelude: null, targetTexts: [first] } };
  }
  if (profile === 'reason') {
    if (second !== undefined) return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
    return {
      ok: true,
      plan: {
        profile,
        prelude: { text: '候補を準備して。', source: 'synthetic' },
        targetTexts: [first],
      },
    };
  }
  if (second === undefined) return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
  return {
    ok: true,
    plan: { profile, prelude: { text: first, source: 'scenario' }, targetTexts: [second] },
  };
};
