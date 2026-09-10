import { describe, expect, it } from 'vitest';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import {
  createLiveEvaluationTurnPlan,
  liveEvaluationProfileFor,
} from '../../tooling/model-eval/live-plan';

const scenarioFor = (id: string) => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`scenario missing: ${id}`);
  return { ...scenario, caseId: `${id}:plan`, repeat: 1 as const };
};

describe('model-eval live turn plans', () => {
  it('exposes only the three executable live profiles', () => {
    expect(liveEvaluationProfileFor(scenarioFor('new-search'))).toBe('new-search');
    expect(liveEvaluationProfileFor(scenarioFor('reason'))).toBe('reason');
    expect(liveEvaluationProfileFor(scenarioFor('continuity'))).toBe('continuity');
    expect(liveEvaluationProfileFor(scenarioFor('compare'))).toBeNull();
  });

  it('uses a synthetic card prelude for reason and the first scenario turn for continuity', () => {
    const reason = createLiveEvaluationTurnPlan(scenarioFor('reason'));
    expect(reason).toMatchObject({
      ok: true,
      plan: {
        profile: 'reason',
        prelude: { source: 'synthetic' },
        targetTexts: [expect.any(String)],
      },
    });
    const continuity = createLiveEvaluationTurnPlan(scenarioFor('continuity'));
    expect(continuity).toMatchObject({
      ok: true,
      plan: {
        profile: 'continuity',
        prelude: { source: 'scenario', text: '青葉カフェを候補にして。' },
        targetTexts: ['2つ目は何時まで？'],
      },
    });
  });

  it('rejects extra turns instead of silently dropping them', () => {
    const scenario = scenarioFor('reason');
    expect(
      createLiveEvaluationTurnPlan({
        ...scenario,
        userTurns: [...scenario.userTurns, '余分なturn'],
      }),
    ).toEqual({ ok: false, code: 'LIVE_TURN_SHAPE_UNSUPPORTED' });
  });
});
