import { describe, expect, it } from 'vitest';
import {
  MODEL_EVALUATION_SCENARIOS,
  expandEvaluationDataset,
} from '../../tooling/model-eval/dataset';
import {
  buildEvaluationTurnRequest,
  type EvaluationCardContext,
} from '../../tooling/model-eval/scenario-input';
import { executionProfileFor } from '../../tooling/model-eval/execution-profile';
import { createEvaluationTurnSeed } from '../../tooling/model-eval/turn-plan';
import type { EvaluationCase } from '../../tooling/model-eval/types';

const scenarioFor = (id: EvaluationCase['id']): EvaluationCase => {
  const scenario = MODEL_EVALUATION_SCENARIOS.find((item) => item.id === id);
  if (scenario === undefined) throw new Error(`scenario missing: ${id}`);
  return { ...scenario, caseId: `${id}:fixture`, repeat: 1 };
};

const seedFor = (evaluationCase: EvaluationCase) => {
  const seed = createEvaluationTurnSeed({
    caseId: evaluationCase.caseId,
    userTurns: evaluationCase.userTurns,
    target: {
      ownerScopeRef: 'model-eval-owner',
      threadId: 'model-eval-thread',
      turnId: 'model-eval-turn-1',
      revision: 1,
    },
  });
  if (!seed.ok) throw new Error(seed.code);
  return seed.seed;
};

const cardContext: EvaluationCardContext = {
  cardSetId: 'model-eval-card-set',
  candidateOrder: ['candidate-a', 'candidate-b'],
  selectedCandidateId: 'candidate-a',
  promotedCandidateId: 'candidate-a',
};

describe('model-eval formal scenario inputs', () => {
  it('keeps the expanded dataset at three repeats while exposing profiles separately', () => {
    expect(expandEvaluationDataset([scenarioFor('reason')])).toHaveLength(3);
    expect(executionProfileFor(scenarioFor('reason'))).toMatchObject({
      status: 'fixture_ready',
      kind: 'card_context',
      requiresApiKey: false,
    });
    expect(executionProfileFor(scenarioFor('continuity'))).toMatchObject({
      status: 'fixture_ready',
      kind: 'same_do_continuity',
    });
    expect(executionProfileFor(scenarioFor('condition-change'))).toMatchObject({
      status: 'fixture_ready',
      kind: 'condition_context',
      requiresApiKey: false,
    });
    expect(executionProfileFor(scenarioFor('mixed-intent'))).toMatchObject({
      status: 'fixture_ready',
      kind: 'condition_context',
      requiresApiKey: false,
    });
    expect(executionProfileFor(scenarioFor('prompt-injection'))).toMatchObject({
      status: 'unavailable',
    });
  });

  it('projects formal card state, saved references, and price conditions into the request', () => {
    const evaluationCase = scenarioFor('condition-change');
    const result = buildEvaluationTurnRequest({
      evaluationCase,
      seed: seedFor(evaluationCase),
      cardContext,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.prefs.budget).toBe('normal');
    expect(result.request.prefs.areaText).toBe('渋谷');
    expect(result.request.cardSetId).toBe(cardContext.cardSetId);
    expect(result.request.candidateOrder).toEqual([...cardContext.candidateOrder]);
    expect(result.request.selectedCandidateId).toBe('candidate-a');
  });

  it('rejects conditions the fixture does not model instead of dropping them', () => {
    const base = scenarioFor('reason');
    const unsupported: EvaluationCase = {
      ...base,
      context: {
        ...base.context,
        activeConditions: [{ field: 'quietness', value: true }],
      },
    };
    const result = buildEvaluationTurnRequest({
      evaluationCase: unsupported,
      seed: seedFor(unsupported),
    });
    expect(result).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
  });

  it('never puts coordinates in a refuse-to-model request', () => {
    const evaluationCase = scenarioFor('gps-refusal');
    const result = buildEvaluationTurnRequest({ evaluationCase, seed: seedFor(evaluationCase) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.location).toMatchObject({
      status: 'denied',
      lat: null,
      lng: null,
      accuracyMeters: null,
      capturedAt: null,
    });
    expect(result.request.prefs.areaText).toBeNull();
    expect(executionProfileFor(evaluationCase)).toMatchObject({
      status: 'unavailable',
      reason: 'LOCATION_POLICY_NOT_WIRED',
    });
  });

  it('redacts an available location before the request reaches the model when policy refuses it', () => {
    const base = scenarioFor('gps-refusal');
    const evaluationCase: EvaluationCase = {
      ...base,
      context: {
        ...base.context,
        locationStatus: 'available',
        locationPolicy: 'refuse-to-model',
        areaText: null,
      },
    };
    const result = buildEvaluationTurnRequest({
      evaluationCase,
      seed: seedFor(evaluationCase),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.location).toMatchObject({
      status: 'denied',
      lat: null,
      lng: null,
      accuracyMeters: null,
      capturedAt: null,
    });
    expect(result.request.prefs.areaText).toBeNull();
  });
});
