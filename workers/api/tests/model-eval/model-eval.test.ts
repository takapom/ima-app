import { describe, expect, it } from 'vitest';
import {
  expandEvaluationDataset,
  MODEL_EVALUATION_SCENARIOS,
} from '../../tooling/model-eval/dataset';
import { aggregateEvaluationRuns } from '../../tooling/model-eval/aggregate';
import { evaluateRun } from '../../tooling/model-eval/rubric';
import type {
  EvaluationCase,
  EvaluationRun,
  EvidenceClaim,
  ExpectedOutcome,
} from '../../tooling/model-eval/types';

const evidenceForCandidate = (candidateId: string): readonly string[] => {
  switch (candidateId) {
    case 'candidate-a':
      return ['ev-a-name'];
    case 'candidate-b':
      return ['ev-b-name'];
    case 'candidate-c':
      return ['ev-c-name'];
  }
  throw new Error(`unknown candidate: ${candidateId}`);
};

const claimForCandidate = (candidateId: string): EvidenceClaim => ({
  id: `claim-${candidateId}`,
  subjectId: candidateId,
  field: 'name',
  assertedValue:
    candidateId === 'candidate-a'
      ? '青葉カフェ'
      : candidateId === 'candidate-b'
        ? '川辺食堂'
        : '駅前ベーカリー',
  evidenceIds: [evidenceForCandidate(candidateId)[0] ?? 'missing-evidence'],
  text: '観測された候補名',
});

const outcomeFor = (evaluationCase: EvaluationCase): ExpectedOutcome => {
  const outcome = evaluationCase.expected.outcomes[0];
  if (outcome === undefined) throw new Error(`scenario has no outcome: ${evaluationCase.id}`);
  return outcome;
};

const validRun = (evaluationCase: EvaluationCase): EvaluationRun => ({
  schemaVersion: 'm25.v1',
  scenarioId: evaluationCase.id,
  repeat: evaluationCase.repeat,
  modelVersion: 'fixture-model-v1',
  promptVersion: 'fixture-prompt-v1',
  response: {
    outcome: {
      kind: outcomeFor(evaluationCase),
      text: `回答 ${evaluationCase.title}`,
    },
    claims: evaluationCase.expected.requiredCandidateIds.map(claimForCandidate),
    selections: evaluationCase.expected.requiredCandidateIds.map((candidateId) => ({
      candidateId,
      evidenceIds: evidenceForCandidate(candidateId),
      why: '観測された情報に基づく候補',
    })),
  },
  trace: {
    complete: true,
    toolCalls: [],
    forbiddenBehaviors: [],
    modelLocationExposed: false,
    selectedCandidateIds: evaluationCase.expected.requiredCandidateIds,
    resolvedSavedPlaceRefs: evaluationCase.expected.requiredSavedPlaceRefs,
    preservedConditionFields: evaluationCase.expected.preserveConditionFields,
    candidateSetChanges: [],
  },
  metrics: {
    latencyMs: 100 + evaluationCase.repeat,
    modelCalls: 1,
    toolCalls: 0,
    upstreamCalls: 0,
    inputTokens: 100,
    outputTokens: 20,
    measuredCostUsd: 0.001,
  },
  humanReview: {
    requestSatisfied: 5,
    groundedness: 5,
    clarity: 5,
    requiredSignals: evaluationCase.expected.requiredSignals.map((signal) => ({
      signal,
      satisfied: true,
    })),
    criticalViolations: [],
  },
});

const allValidRuns = (): readonly EvaluationRun[] => expandEvaluationDataset().map(validRun);

describe('M25 model evaluation dataset', () => {
  it('contains eight response patterns and six cross-cutting scenarios', () => {
    expect(MODEL_EVALUATION_SCENARIOS).toHaveLength(14);
    expect(new Set(MODEL_EVALUATION_SCENARIOS.map((scenario) => scenario.pattern)).size).toBe(8);
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
      'saved-place-reference',
    ]);
    const continuity = MODEL_EVALUATION_SCENARIOS.find((scenario) => scenario.id === 'continuity');
    if (continuity === undefined) throw new Error('continuity scenario missing');
    expect(continuity.context.orderedCandidateIds[1]).toBe('candidate-b');
    expect(continuity.context.selectedCandidateId).toBe('candidate-a');
    expect(continuity.context.savedPlaceRefs).toEqual([]);
    expect(continuity.expected.requiredCandidateIds).toEqual(['candidate-b']);
  });

  it('expands every scenario to exactly three independently identified repeats', () => {
    const cases = expandEvaluationDataset();
    expect(cases).toHaveLength(42);
    expect(new Set(cases.map((evaluationCase) => evaluationCase.caseId)).size).toBe(42);
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
        claims: [{ ...claim, assertedValue: '別の店' }],
      },
    };
    expect(evaluateRun(evaluationCase, altered).criticalViolations).toContain('unsupported-claim');
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
            field: 'openUntil',
            assertedValue: '23:00',
            evidenceIds: ['ev-expired-open'],
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
            evidenceIds: ['ev-b-name'],
            why: '誤った候補根拠',
          },
        ],
      },
    };
    expect(evaluateRun(evaluationCase, altered).criticalViolations).toContain(
      'candidate-misidentification',
    );
  });

  it('does not turn a provider description into a quietness fact', () => {
    const scenario = MODEL_EVALUATION_SCENARIOS.find((entry) => entry.id === 'condition-change');
    if (scenario === undefined) throw new Error('condition scenario missing');
    const description = scenario.context.evidence.find((entry) => entry.id === 'ev-a-description');
    if (description === undefined) throw new Error('description evidence missing');
    expect(description.field).toBe('description');
    expect(scenario.context.evidence.some((entry) => entry.field === 'quiet')).toBe(false);
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
        resolvedSavedPlaceRefs: [],
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
  it('passes the 14-scenario, three-repeat gate with grounded human reviews', () => {
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
    expect(report.gates.humanReviewCount).toBe(41);
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
    expect(report.gates.humanReviewPassRate).toBeCloseTo(39 / 42);
    expect(report.gates.humanReview).toBe(true);
    expect(report.gates.passed).toBe(true);
  });

  it('fails below 90 percent and fails any human critical violation independently', () => {
    const belowThreshold = [...allValidRuns()];
    for (const index of [0, 1, 2, 3, 4]) {
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
        modelCalls: null,
        toolCalls: null,
        upstreamCalls: null,
        inputTokens: null,
        outputTokens: null,
        measuredCostUsd: null,
      },
    }));
    const report = aggregateEvaluationRuns(runs);
    expect(report.metrics.latencyMs.samples).toBe(0);
    expect(report.metrics.latencyMs.unknown).toBe(42);
    expect(report.metrics.costUsd.knownSamples).toBe(0);
    expect(report.metrics.costUsd.unknownSamples).toBe(42);
    expect(report.metrics.costUsd.totalUsd).toBeNull();
  });

  it('keeps p50/p95 and model, tool, upstream, token, and cost metrics separate', () => {
    const report = aggregateEvaluationRuns(allValidRuns());
    expect(report.metrics.latencyMs.p50).toBe(102);
    expect(report.metrics.latencyMs.p95).toBe(103);
    expect(report.metrics.modelCalls.total).toBe(42);
    expect(report.metrics.toolCalls.total).toBe(0);
    expect(report.metrics.upstreamCalls.total).toBe(0);
    expect(report.metrics.inputTokens.total).toBe(4200);
    expect(report.metrics.outputTokens.total).toBe(840);
    expect(report.metrics.costUsd.totalUsd).toBeCloseTo(0.042);
    expect(report.versions.modelVersions).toEqual(['fixture-model-v1']);
    expect(report.versions.promptVersions).toEqual(['fixture-prompt-v1']);
  });
});
