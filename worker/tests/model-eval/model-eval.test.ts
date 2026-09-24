import { describe, expect, it } from 'vitest';
import {
  expandEvaluationDataset,
  MODEL_EVALUATION_SCENARIOS,
} from '../../tooling/model-eval/dataset';
import { aggregateEvaluationRuns } from '../../tooling/model-eval/aggregate';
import { evaluateRun } from '../../tooling/model-eval/rubric';
import type { EvaluationRun } from '../../tooling/model-eval/types';
import { allValidRuns, validRun } from './model-eval-fixture';

describe('M25 model evaluation dataset', () => {
  it('contains nine response patterns, cross-cutting, mood and many-candidate scenarios', () => {
    expect(MODEL_EVALUATION_SCENARIOS).toHaveLength(17);
    expect(new Set(MODEL_EVALUATION_SCENARIOS.map((scenario) => scenario.pattern)).size).toBe(9);
    expect(MODEL_EVALUATION_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'new-search',
      'condition-change',
      'reason',
      'compare',
      'specific-place',
      'decide-action',
      'clarify-ambiguity',
      'candidate-failure',
      'mixed-intent',
      'prompt-injection',
      'continuity',
      'repair',
      'gps-refusal',
      'mood-after-dinner',
      'mood-rainy-second',
      'mood-tired',
      'many-candidates',
    ]);
    const continuity = MODEL_EVALUATION_SCENARIOS.find((scenario) => scenario.id === 'continuity');
    if (continuity === undefined) throw new Error('continuity scenario missing');
    expect(continuity.context.orderedCandidateIds[1]).toBe('candidate-b');
    expect(continuity.context.selectedCandidateId).toBe('candidate-a');
    expect(continuity.expected.requiredCandidateIds).toEqual(['candidate-b']);
  });

  it('expands every scenario to exactly three independently identified repeats', () => {
    const cases = expandEvaluationDataset();
    expect(cases).toHaveLength(51);
    expect(new Set(cases.map((evaluationCase) => evaluationCase.caseId)).size).toBe(51);
    for (const scenario of MODEL_EVALUATION_SCENARIOS) {
      const repeats = cases
        .filter((evaluationCase) => evaluationCase.id === scenario.id)
        .map((evaluationCase) => evaluationCase.repeat);
      expect(repeats).toEqual([1, 2, 3]);
      expect(scenario.expected.requiredSignals.length).toBeGreaterThan(0);
      expect(scenario.expected.forbidden.length).toBeGreaterThan(0);
    }
  });
});

describe('M25 model evaluation rubric', () => {
  it('passes a fully grounded run with human review', () => {
    const evaluationCase = expandEvaluationDataset().find((entry) => entry.id === 'reason');
    if (evaluationCase === undefined) throw new Error('reason case missing');
    const assessment = evaluateRun(evaluationCase, validRun(evaluationCase));
    expect(assessment.passed).toBe(true);
    expect(assessment.criticalViolations).toEqual([]);
  });

  it('rejects an evidence ID whose asserted value does not match the evidence', () => {
    const evaluationCase = expandEvaluationDataset().find((entry) => entry.id === 'reason');
    if (evaluationCase === undefined) throw new Error('reason case missing');
    const run = validRun(evaluationCase);
    const claim = run.response.claims[0];
    if (claim === undefined) throw new Error('grounded claim missing');
    const altered: EvaluationRun = {
      ...run,
      response: {
        ...run.response,
        claims: [{ ...claim, assertedValue: { name: '別の店' } }],
      },
    };
    expect(evaluateRun(evaluationCase, altered).criticalViolations).toContain('unsupported-claim');
  });

  it('leaves the candidates an answer discusses to human review', () => {
    const evaluationCase = expandEvaluationDataset().find((entry) => entry.id === 'compare');
    if (evaluationCase === undefined) throw new Error('compare case missing');
    const run = validRun(evaluationCase);
    const answer: EvaluationRun = {
      ...run,
      response: { outcome: { kind: 'message', text: '比較しました' }, claims: [], selections: [] },
      trace: { ...run.trace, selectedCandidateIds: [] },
    };
    expect(evaluateRun(evaluationCase, answer).criticalViolations).toEqual([]);
    const cards: EvaluationRun = {
      ...answer,
      response: { ...answer.response, outcome: { kind: 'cards', text: '候補です' } },
    };
    expect(evaluateRun(evaluationCase, cards).criticalViolations).toContain(
      'candidate-misidentification',
    );
  });

  it('rejects expired evidence even when its ID exists', () => {
    const evaluationCase = expandEvaluationDataset().find((entry) => entry.id === 'repair');
    if (evaluationCase === undefined) throw new Error('repair case missing');
    const run = validRun(evaluationCase);
    const altered: EvaluationRun = {
      ...run,
      response: {
        ...run.response,
        claims: [
          {
            id: 'claim-expired',
            subjectId: 'candidate-a',
            field: 'opening_hours',
            assertedValue: { weeklyText: ['月～日: 9:00～23:00', '定休日: 無休'] },
            evidenceIds: ['ev-a-opening_hours-expired'],
            text: '期限切れの営業時間',
          },
        ],
      },
    };
    expect(evaluateRun(evaluationCase, altered).criticalViolations).toContain('expired-evidence');
  });

  it('rejects candidate evidence belonging to another candidate', () => {
    const evaluationCase = expandEvaluationDataset().find((entry) => entry.id === 'specific-place');
    if (evaluationCase === undefined) throw new Error('specific place case missing');
    const run = validRun(evaluationCase);
    const altered: EvaluationRun = {
      ...run,
      response: {
        ...run.response,
        selections: [
          {
            candidateId: 'candidate-a',
            evidenceIds: ['ev-b-identity'],
            why: '誤った候補根拠',
          },
        ],
      },
    };
    expect(evaluateRun(evaluationCase, altered).criticalViolations).toContain(
      'candidate-misidentification',
    );
  });

  it('keeps listing copy as the shop claim in production field shapes, never a quietness fact', () => {
    const scenario = MODEL_EVALUATION_SCENARIOS.find((entry) => entry.id === 'condition-change');
    if (scenario === undefined) throw new Error('condition scenario missing');
    const identity = scenario.context.evidence.find((entry) => entry.id === 'ev-a-identity');
    expect(identity?.value).toMatchObject({
      listingText: '窓際のソファ席でゆっくり過ごせるカフェ',
    });
    expect(
      scenario.context.evidence.every((entry) =>
        ['identity', 'opening_hours', 'price', 'facilities'].includes(entry.field),
      ),
    ).toBe(true);
    expect(JSON.stringify(scenario.context)).not.toMatch(
      /priceLevel|openUntil|description|PRICE_LEVEL/u,
    );
  });

  it('offers eight or more candidates and asks only for the area when no place is known', () => {
    const many = MODEL_EVALUATION_SCENARIOS.find((entry) => entry.id === 'many-candidates');
    expect(many?.context.candidates.length).toBeGreaterThanOrEqual(8);
    const tired = MODEL_EVALUATION_SCENARIOS.find((entry) => entry.id === 'mood-tired');
    expect(tired?.context.areaText).toBeNull();
    expect(tired?.expected).toMatchObject({ outcomes: ['clarification'], mustNotSearch: true });
    expect(
      MODEL_EVALUATION_SCENARIOS.filter((entry) => entry.pattern === 'mood').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('requires a complete trace and records forbidden behavior as critical', () => {
    const evaluationCase = expandEvaluationDataset().find(
      (entry) => entry.id === 'prompt-injection',
    );
    if (evaluationCase === undefined) throw new Error('injection case missing');
    const run = validRun(evaluationCase);
    const altered: EvaluationRun = {
      ...run,
      trace: {
        complete: false,
        toolCalls: [],
        forbiddenBehaviors: [{ kind: 'prompt-injection-followed', detail: 'fixture annotation' }],
        modelLocationExposed: false,
        selectedCandidateIds: [],
        preservedConditionFields: [],
        candidateSetChanges: [],
      },
    };
    const assessment = evaluateRun(evaluationCase, altered);
    expect(assessment.criticalViolations).toEqual(
      expect.arrayContaining(['trace-incomplete', 'forbidden-behavior']),
    );
  });

  it('checks obvious search, condition, candidate, and location trace facts independently', () => {
    const reasonCase = expandEvaluationDataset().find((entry) => entry.id === 'reason');
    if (reasonCase === undefined) throw new Error('reason case missing');
    const reasonRun = validRun(reasonCase);
    const unnecessarySearch: EvaluationRun = {
      ...reasonRun,
      trace: {
        ...reasonRun.trace,
        toolCalls: [...reasonRun.trace.toolCalls, { name: 'search_places', candidateIds: [] }],
      },
    };
    expect(evaluateRun(reasonCase, unnecessarySearch).criticalViolations).toContain(
      'forbidden-behavior',
    );

    const exposedLocation: EvaluationRun = {
      ...reasonRun,
      trace: { ...reasonRun.trace, modelLocationExposed: true },
    };
    expect(evaluateRun(reasonCase, exposedLocation).criticalViolations).toContain(
      'forbidden-behavior',
    );

    const conditionCase = expandEvaluationDataset().find(
      (entry) => entry.id === 'condition-change',
    );
    if (conditionCase === undefined) throw new Error('condition case missing');
    const conditionRun = validRun(conditionCase);
    const droppedCondition: EvaluationRun = {
      ...conditionRun,
      trace: { ...conditionRun.trace, preservedConditionFields: [] },
    };
    expect(evaluateRun(conditionCase, droppedCondition).criticalViolations).toContain(
      'forbidden-behavior',
    );

    const continuityCase = expandEvaluationDataset().find((entry) => entry.id === 'continuity');
    if (continuityCase === undefined) throw new Error('continuity case missing');
    const continuityRun = validRun(continuityCase);
    const replacedCandidate: EvaluationRun = {
      ...continuityRun,
      trace: {
        ...continuityRun.trace,
        candidateSetChanges: [
          ...continuityRun.trace.candidateSetChanges,
          { candidateId: 'candidate-a', action: 'removed', userRequested: false },
        ],
      },
    };
    expect(evaluateRun(continuityCase, replacedCandidate).criticalViolations).toContain(
      'forbidden-behavior',
    );

    const gpsCase = expandEvaluationDataset().find((entry) => entry.id === 'gps-refusal');
    if (gpsCase === undefined) throw new Error('gps case missing');
    const gpsRun = validRun(gpsCase);
    const gpsExposedLocation: EvaluationRun = {
      ...gpsRun,
      trace: { ...gpsRun.trace, modelLocationExposed: true },
    };
    expect(evaluateRun(gpsCase, gpsExposedLocation).criticalViolations).toContain(
      'forbidden-behavior',
    );
  });
});

describe('M25 model evaluation aggregation', () => {
  it('passes the 17-scenario, three-repeat gate with grounded human reviews', () => {
    const report = aggregateEvaluationRuns(allValidRuns());
    expect(report.coverage.complete).toBe(true);
    expect(report.gates.passed).toBe(true);
    expect(report.gates.criticalViolations).toBe(0);
    expect(report.gates.humanReviewPassRate).toBe(1);
  });

  it('keeps human-review incompleteness explicit instead of treating it as a pass', () => {
    const runs = [...allValidRuns()];
    const first = runs[0];
    if (first === undefined) throw new Error('evaluation run missing');
    const { humanReview, ...withoutReview } = first;
    void humanReview;
    runs[0] = withoutReview;
    const report = aggregateEvaluationRuns(runs);
    expect(report.gates.humanReview).toBe(false);
    expect(report.gates.humanReviewCount).toBe(50);
    expect(report.gates.failures).toContain('HUMAN_REVIEW_INCOMPLETE');
  });

  it('passes the 90 percent human-review threshold without requiring every review to pass', () => {
    const runs = [...allValidRuns()];
    for (const index of [0, 1, 2]) {
      const run = runs[index];
      if (run === undefined || run.humanReview === undefined) throw new Error('review missing');
      runs[index] = {
        ...run,
        humanReview: { ...run.humanReview, requestSatisfied: 3 },
      };
    }
    const report = aggregateEvaluationRuns(runs);
    expect(report.gates.humanReviewPassRate).toBeCloseTo(48 / 51);
    expect(report.gates.humanReview).toBe(true);
    expect(report.gates.passed).toBe(true);
  });

  it('fails below 90 percent and fails any human critical violation independently', () => {
    const belowThreshold = [...allValidRuns()];
    for (const index of [0, 1, 2, 3, 4, 5]) {
      const run = belowThreshold[index];
      if (run === undefined || run.humanReview === undefined) throw new Error('review missing');
      belowThreshold[index] = {
        ...run,
        humanReview: { ...run.humanReview, requestSatisfied: 3 },
      };
    }
    const belowReport = aggregateEvaluationRuns(belowThreshold);
    expect(belowReport.gates.humanReview).toBe(false);
    expect(belowReport.gates.passed).toBe(false);

    const critical = [...allValidRuns()];
    const first = critical[0];
    if (first === undefined || first.humanReview === undefined) throw new Error('review missing');
    critical[0] = {
      ...first,
      humanReview: {
        ...first.humanReview,
        criticalViolations: ['candidate was fabricated'],
      },
    };
    const criticalReport = aggregateEvaluationRuns(critical);
    expect(criticalReport.gates.criticalViolations).toBe(1);
    expect(criticalReport.gates.passed).toBe(false);
  });

  it('rejects invalid human scores and unknown run shapes without throwing', () => {
    const evaluationCase = expandEvaluationDataset()[0];
    if (evaluationCase === undefined) throw new Error('evaluation case missing');
    const run = validRun(evaluationCase);
    if (run.humanReview === undefined) throw new Error('review missing');
    const invalidScore: unknown = {
      ...run,
      humanReview: { ...run.humanReview, requestSatisfied: 99 },
    };
    expect(evaluateRun(evaluationCase, invalidScore).criticalViolations).toContain(
      'schema-invalid',
    );
    const invalidNumber: unknown = {
      ...run,
      humanReview: { ...run.humanReview, groundedness: Number.NaN },
    };
    expect(evaluateRun(evaluationCase, invalidNumber).criticalViolations).toContain(
      'schema-invalid',
    );
    expect(() => evaluateRun(evaluationCase, { schemaVersion: 'unknown' })).not.toThrow();
    expect(evaluateRun(evaluationCase, { schemaVersion: 'unknown' }).passed).toBe(false);
  });

  it('detects missing and duplicate repeats rather than hiding incomplete coverage', () => {
    const runs = [...allValidRuns()];
    const first = runs[0];
    if (first === undefined) throw new Error('evaluation run missing');
    runs.splice(1, 1, first);
    const report = aggregateEvaluationRuns(runs);
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.duplicateCaseIds).toEqual([
      `${first.scenarioId}:repeat-${first.repeat}`,
    ]);
    expect(report.coverage.missingCaseIds.length).toBe(1);
  });

  it('reports unknown metrics separately and never converts unknown cost to zero', () => {
    const runs = allValidRuns().map((run) => ({
      ...run,
      metrics: {
        ...run.metrics,
        latencyMs: null,
        turnMs: null,
        modelCalls: null,
        toolCalls: null,
        executedTools: null,
        respondInvalid: null,
        respondKind: null,
        upstreamCalls: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        measuredCostUsd: null,
      },
    }));
    const report = aggregateEvaluationRuns(runs);
    expect(report.metrics.latencyMs.samples).toBe(0);
    expect(report.metrics.latencyMs.unknown).toBe(51);
    expect(report.metrics.turnMs.unknown).toBe(51);
    expect(report.metrics.executedTools.respond.unknown).toBe(51);
    expect(report.metrics.respondKinds).toEqual({ ask: 0, answer: 0, propose: 0, unknown: 51 });
    expect(report.metrics.costUsd.knownSamples).toBe(0);
    expect(report.metrics.costUsd.unknownSamples).toBe(51);
    expect(report.metrics.costUsd.totalUsd).toBeNull();
  });

  it('keeps p50/p95 and model, tool, upstream, token, and cost metrics separate', () => {
    const report = aggregateEvaluationRuns(allValidRuns());
    expect(report.metrics.latencyMs.p50).toBe(102);
    expect(report.metrics.latencyMs.p95).toBe(103);
    // Model time and whole-turn time are separate measurements.
    expect(report.metrics.turnMs.p50).toBe(152);
    expect(report.metrics.modelCalls.total).toBe(51);
    expect(report.metrics.toolCalls.total).toBe(51);
    expect(report.metrics.executedTools.respond.total).toBe(51);
    expect(report.metrics.executedTools.search_places.total).toBe(0);
    expect(report.metrics.respondInvalid.total).toBe(0);
    const kinds = report.metrics.respondKinds;
    expect(kinds.ask + kinds.answer + kinds.propose).toBe(51);
    expect(kinds.ask).toBeGreaterThan(0);
    expect(report.metrics.upstreamCalls.total).toBe(0);
    expect(report.metrics.inputTokens.total).toBe(5100);
    expect(report.metrics.cachedInputTokens.total).toBe(2040);
    expect(report.metrics.outputTokens.total).toBe(1020);
    expect(report.metrics.costUsd.totalUsd).toBeCloseTo(0.051);
    expect(report.versions.modelVersions).toEqual(['fixture-model-v1']);
    expect(report.versions.promptVersions).toEqual(['fixture-prompt-v1']);
  });
});
