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
  it('exposes every profile with an executable live turn shape', () => {
    expect(liveEvaluationProfileFor(scenarioFor('new-search'))).toBe('new-search');
    expect(liveEvaluationProfileFor(scenarioFor('condition-change'))).toBe('condition-change');
    expect(liveEvaluationProfileFor(scenarioFor('mixed-intent'))).toBe('mixed-intent');
    expect(liveEvaluationProfileFor(scenarioFor('reason'))).toBe('reason');
    expect(liveEvaluationProfileFor(scenarioFor('continuity'))).toBe('continuity');
    expect(liveEvaluationProfileFor(scenarioFor('compare'))).toBe('compare');
    expect(liveEvaluationProfileFor(scenarioFor('specific-place'))).toBe('specific-place');
    expect(liveEvaluationProfileFor(scenarioFor('decide-action'))).toBe('decide-action');
    expect(liveEvaluationProfileFor(scenarioFor('clarify-ambiguity'))).toBe('clarify-ambiguity');
    expect(liveEvaluationProfileFor(scenarioFor('repair'))).toBe('repair');
    expect(liveEvaluationProfileFor(scenarioFor('candidate-failure'))).toBe('candidate-failure');
    expect(liveEvaluationProfileFor(scenarioFor('prompt-injection'))).toBe('prompt-injection');
    expect(liveEvaluationProfileFor(scenarioFor('gps-refusal'))).toBe('gps-refusal');
  });

  it('passes condition and mixed-intent turns directly to the live model', () => {
    for (const id of ['condition-change', 'mixed-intent'] as const) {
      const scenario = scenarioFor(id);
      expect(createLiveEvaluationTurnPlan(scenario)).toEqual({
        ok: true,
        plan: {
          profile: id,
          prelude: null,
          targetTexts: [scenario.userTurns[0]],
        },
      });
    }
  });

  it('passes direct one-turn profiles, including GPS refusal, to the live model', () => {
    for (const id of ['candidate-failure', 'prompt-injection', 'gps-refusal'] as const) {
      const scenario = scenarioFor(id);
      expect(createLiveEvaluationTurnPlan(scenario)).toEqual({
        ok: true,
        plan: {
          profile: id,
          prelude: null,
          targetTexts: [scenario.userTurns[0]],
        },
      });
    }
  });

  it('uses one synthetic card prelude for each formal card-context profile', () => {
    for (const id of [
      'compare',
      'specific-place',
      'decide-action',
      'clarify-ambiguity',
      'repair',
    ] as const) {
      expect(createLiveEvaluationTurnPlan(scenarioFor(id))).toMatchObject({
        ok: true,
        plan: {
          profile: id,
          prelude: { source: 'synthetic' },
          targetTexts: [expect.any(String)],
        },
      });
    }
  });

  it('keeps specific-place and repair clock transitions explicit', () => {
    for (const id of ['specific-place', 'repair'] as const) {
      const result = createLiveEvaluationTurnPlan(scenarioFor(id), {
        preludeClientNow: '2026-09-10T10:00:00.000Z',
        targetClientNow: '2026-09-10T12:00:00.000Z',
      });
      expect(result).toMatchObject({
        ok: true,
        plan: {
          profile: id,
          prelude: { source: 'synthetic', clientNow: '2026-09-10T10:00:00.000Z' },
          targetClientNow: '2026-09-10T12:00:00.000Z',
        },
      });
    }
  });

  it('can explicitly advance the fixture clock without changing scenario defaults', () => {
    const result = createLiveEvaluationTurnPlan(scenarioFor('decide-action'), {
      preludeClientNow: '2026-09-10T10:00:00.000Z',
      targetClientNow: '2026-09-10T12:00:00.000Z',
    });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        prelude: { clientNow: '2026-09-10T10:00:00.000Z' },
        targetClientNow: '2026-09-10T12:00:00.000Z',
      },
    });
    const defaults = createLiveEvaluationTurnPlan(scenarioFor('decide-action'));
    expect(defaults.ok).toBe(true);
    if (defaults.ok) {
      expect(defaults.plan.prelude).not.toHaveProperty('clientNow');
      expect(defaults.plan).not.toHaveProperty('targetClientNow');
    }
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
