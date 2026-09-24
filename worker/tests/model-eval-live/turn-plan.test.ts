import { describe, expect, it } from 'vitest';
import { MODEL_EVALUATION_SCENARIOS } from '../../tooling/model-eval/dataset';
import {
  advanceEvaluationTurn,
  createEvaluationTurnSeed,
} from '../../tooling/model-eval/turn-plan';

const target = {
  ownerScopeRef: 'model-eval-owner',
  threadId: 'model-eval-thread',
  turnId: 'model-eval-turn-1',
  revision: 1,
} as const;

const previousResponse = {
  schemaVersion: 'v1',
  threadId: target.threadId,
  turnId: target.turnId,
  responseId: 'model-eval-response-1',
  revision: 2,
  kind: 'message' as const,
  presentation: 'keep' as const,
  cardSetId: null,
  message: [
    {
      text: '青葉カフェを確認しました。',
      retention: {
        retentionDecision: 'deny' as const,
        retentionMode: 'none' as const,
        sessionExpiresAt: '2026-09-10T18:00:00.000Z',
        freshUntil: null,
        displayUntil: null,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution: null,
        restoreMode: 'unavailable' as const,
        policyStatus: 'expired' as const,
        displayPolicyStatus: 'expired' as const,
      },
    },
  ],
} as const;

describe('model-eval multi-turn planner', () => {
  it('seeds and advances continuity from the validated response revision', () => {
    const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === 'continuity');
    if (scenario === undefined) throw new Error('continuity scenario is missing');
    const first = createEvaluationTurnSeed({
      caseId: 'continuity:repeat-1',
      userTurns: scenario.userTurns,
      target,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.seed.text).toBe('青葉カフェを候補にして。');
    expect(first.seed.target.revision).toBe(1);

    const second = advanceEvaluationTurn(first.seed, previousResponse, scenario.userTurns[1] ?? '');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.seed.text).toBe('2つ目は何時まで？');
    expect(second.seed.target).toEqual({
      ownerScopeRef: target.ownerScopeRef,
      threadId: target.threadId,
      turnId: 'model-eval-continuity_repeat-1-turn-2',
      revision: 2,
    });
  });

  it('rejects replay references and mismatched prior responses', () => {
    const first = createEvaluationTurnSeed({
      caseId: 'continuity:repeat-1',
      userTurns: ['first', 'second'],
      target,
    });
    if (!first.ok) throw new Error('expected seed');
    expect(advanceEvaluationTurn(first.seed, { restoreMode: 'reference_only' }, 'second')).toEqual({
      ok: false,
      code: 'MULTI_TURN_RESPONSE_INVALID',
    });
    expect(
      advanceEvaluationTurn(first.seed, { ...previousResponse, revision: 3 }, 'second'),
    ).toEqual({
      ok: false,
      code: 'MULTI_TURN_RESPONSE_INVALID',
    });
  });

  it('does not create a seed without a first user turn or a valid target', () => {
    expect(
      createEvaluationTurnSeed({
        caseId: 'empty',
        userTurns: [],
        target,
      }),
    ).toEqual({ ok: false, code: 'MULTI_TURN_SEED_UNAVAILABLE' });
    expect(
      createEvaluationTurnSeed({
        caseId: 'invalid-target',
        userTurns: ['first'],
        target: { ...target, revision: 0 },
      }),
    ).toEqual({ ok: false, code: 'MULTI_TURN_SEED_UNAVAILABLE' });
  });
});
