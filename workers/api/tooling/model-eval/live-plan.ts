import type { EvaluationCase, ScenarioId } from './types';

export type LiveEvaluationProfile =
  | 'new-search'
  | 'condition-change'
  | 'mixed-intent'
  | 'reason'
  | 'continuity'
  | 'compare'
  | 'decide-action'
  | 'clarify-ambiguity'
  | 'specific-place'
  | 'repair'
  | 'candidate-failure'
  | 'prompt-injection';

export type LiveEvaluationTiming = {
  readonly preludeClientNow?: string;
  readonly targetClientNow?: string;
};

export type LiveEvaluationPrelude = {
  readonly text: string;
  readonly source: 'scenario' | 'synthetic';
  readonly clientNow?: string;
};

export type LiveEvaluationTurnPlan = {
  readonly profile: LiveEvaluationProfile;
  readonly prelude: LiveEvaluationPrelude | null;
  readonly targetTexts: readonly [string];
  readonly targetClientNow?: string;
};

export type LiveEvaluationTurnPlanResult =
  | { readonly ok: true; readonly plan: LiveEvaluationTurnPlan }
  | {
      readonly ok: false;
      readonly code: 'LIVE_PROFILE_UNAVAILABLE' | 'LIVE_TURN_SHAPE_UNSUPPORTED';
    };

const profileFor: Partial<Record<ScenarioId, LiveEvaluationProfile>> = {
  'new-search': 'new-search',
  'condition-change': 'condition-change',
  'mixed-intent': 'mixed-intent',
  reason: 'reason',
  continuity: 'continuity',
  compare: 'compare',
  'specific-place': 'specific-place',
  'decide-action': 'decide-action',
  'clarify-ambiguity': 'clarify-ambiguity',
  repair: 'repair',
  'candidate-failure': 'candidate-failure',
  'prompt-injection': 'prompt-injection',
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
  timing: LiveEvaluationTiming = {},
): LiveEvaluationTurnPlanResult => {
  const profile = liveEvaluationProfileFor(evaluationCase);
  if (profile === null) return { ok: false, code: 'LIVE_PROFILE_UNAVAILABLE' };
  const [first, second, ...extra] = evaluationCase.userTurns;
  if (extra.length > 0 || first === undefined) {
    return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
  }
  if (
    profile === 'new-search' ||
    profile === 'condition-change' ||
    profile === 'mixed-intent' ||
    profile === 'candidate-failure' ||
    profile === 'prompt-injection'
  ) {
    if (second !== undefined) return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
    return {
      ok: true,
      plan: {
        profile,
        prelude: null,
        targetTexts: [first],
        ...(timing.targetClientNow === undefined
          ? {}
          : { targetClientNow: timing.targetClientNow }),
      },
    };
  }
  if (
    profile === 'reason' ||
    profile === 'compare' ||
    profile === 'specific-place' ||
    profile === 'decide-action' ||
    profile === 'clarify-ambiguity' ||
    profile === 'repair'
  ) {
    if (second !== undefined) return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
    return {
      ok: true,
      plan: {
        profile,
        prelude: {
          text: '候補を準備して。',
          source: 'synthetic',
          ...(timing.preludeClientNow === undefined ? {} : { clientNow: timing.preludeClientNow }),
        },
        targetTexts: [first],
        ...(timing.targetClientNow === undefined
          ? {}
          : { targetClientNow: timing.targetClientNow }),
      },
    };
  }
  if (second === undefined) return { ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' };
  return {
    ok: true,
    plan: {
      profile,
      prelude: {
        text: first,
        source: 'scenario',
        ...(timing.preludeClientNow === undefined ? {} : { clientNow: timing.preludeClientNow }),
      },
      targetTexts: [second],
      ...(timing.targetClientNow === undefined ? {} : { targetClientNow: timing.targetClientNow }),
    },
  };
};
