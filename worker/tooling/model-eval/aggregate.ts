import { expandEvaluationDataset, MODEL_EVALUATION_SCENARIOS } from './dataset';
import { evaluateRun } from './rubric';
import {
  MODEL_EVAL_SCHEMA_VERSION,
  type EvaluationReport,
  type EvaluationRun,
  type EvaluationScenario,
  type MetricSummary,
  type PublicToolName,
} from './types';

const numericOrUnknown = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null;

const percentile = (values: readonly number[], ratio: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index] ?? null;
};

const metricSummary = (values: readonly (number | null)[]): MetricSummary => {
  const known = values.flatMap((value) => {
    const numeric = numericOrUnknown(value);
    return numeric === null ? [] : [numeric];
  });
  return {
    samples: known.length,
    unknown: values.length - known.length,
    p50: percentile(known, 0.5),
    p95: percentile(known, 0.95),
    total: known.length === 0 ? null : known.reduce((total, value) => total + value, 0),
  };
};

const costSummary = (values: readonly (number | null)[]) => {
  const known = values.flatMap((value) => {
    const numeric = numericOrUnknown(value);
    return numeric === null ? [] : [numeric];
  });
  const totalUsd = known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
  return {
    knownSamples: known.length,
    unknownSamples: values.length - known.length,
    totalUsd,
    averageUsd: totalUsd === null ? null : totalUsd / known.length,
  };
};

const caseIdFor = (run: EvaluationRun): string => `${run.scenarioId}:repeat-${run.repeat}`;

const uniqueSorted = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

export const aggregateEvaluationRuns = (
  runs: readonly EvaluationRun[],
  scenarios: readonly EvaluationScenario[] = MODEL_EVALUATION_SCENARIOS,
): EvaluationReport => {
  const cases = expandEvaluationDataset(scenarios);
  const expectedIds = new Set(cases.map((evaluationCase) => evaluationCase.caseId));
  const caseById = new Map(cases.map((evaluationCase) => [evaluationCase.caseId, evaluationCase]));
  const actualIds = runs.map(caseIdFor);
  const counts = new Map<string, number>();
  for (const caseId of actualIds) counts.set(caseId, (counts.get(caseId) ?? 0) + 1);
  const duplicateCaseIds = uniqueSorted(
    [...counts].filter(([, count]) => count > 1).map(([caseId]) => caseId),
  );
  const unexpectedCaseIds = uniqueSorted(actualIds.filter((caseId) => !expectedIds.has(caseId)));
  const actualSet = new Set(actualIds);
  const missingCaseIds = uniqueSorted([...expectedIds].filter((caseId) => !actualSet.has(caseId)));
  const coverage = {
    expected: cases.length,
    actual: runs.length,
    missingCaseIds,
    duplicateCaseIds,
    unexpectedCaseIds,
    complete:
      runs.length === cases.length &&
      missingCaseIds.length === 0 &&
      duplicateCaseIds.length === 0 &&
      unexpectedCaseIds.length === 0,
  };

  const assessments = runs.flatMap((run) => {
    const evaluationCase = caseById.get(caseIdFor(run));
    return evaluationCase === undefined ? [] : [evaluateRun(evaluationCase, run)];
  });
  const versions = {
    modelVersions: uniqueSorted(
      runs.map((run) => run.modelVersion).filter((value) => value !== ''),
    ),
    promptVersions: uniqueSorted(
      runs.map((run) => run.promptVersion).filter((value) => value !== ''),
    ),
    complete:
      runs.length === cases.length &&
      runs.every(
        (run) => run.modelVersion.trim().length > 0 && run.promptVersion.trim().length > 0,
      ),
  };

  const executed = (name: PublicToolName) =>
    metricSummary(runs.map((run) => run.metrics.executedTools?.[name] ?? null));
  const kindCount = (kind: EvaluationRun['metrics']['respondKind']) =>
    runs.filter((run) => run.metrics.respondKind === kind).length;
  const metrics = {
    latencyMs: metricSummary(runs.map((run) => run.metrics.latencyMs)),
    turnMs: metricSummary(runs.map((run) => run.metrics.turnMs)),
    modelCalls: metricSummary(runs.map((run) => run.metrics.modelCalls)),
    toolCalls: metricSummary(runs.map((run) => run.metrics.toolCalls)),
    executedTools: {
      search_places: executed('search_places'),
      get_place_details: executed('get_place_details'),
      respond: executed('respond'),
    },
    respondInvalid: metricSummary(runs.map((run) => run.metrics.respondInvalid)),
    respondKinds: {
      ask: kindCount('ask'),
      answer: kindCount('answer'),
      propose: kindCount('propose'),
      unknown: kindCount(null),
    },
    upstreamCalls: metricSummary(runs.map((run) => run.metrics.upstreamCalls)),
    inputTokens: metricSummary(runs.map((run) => run.metrics.inputTokens)),
    cachedInputTokens: metricSummary(runs.map((run) => run.metrics.cachedInputTokens)),
    outputTokens: metricSummary(runs.map((run) => run.metrics.outputTokens)),
    costUsd: costSummary(runs.map((run) => run.metrics.measuredCostUsd)),
  };

  const criticalViolations = assessments.reduce(
    (total, assessment) => total + assessment.criticalViolations.length,
    0,
  );
  const humanReviewCount = assessments.filter(
    (assessment) => assessment.humanReviewPassed !== null,
  ).length;
  const humanReviewPasses = assessments.filter(
    (assessment) => assessment.humanReviewPassed === true,
  ).length;
  const humanReviewPassRate = cases.length === 0 ? null : humanReviewPasses / cases.length;
  const humanReview =
    coverage.complete &&
    humanReviewCount === cases.length &&
    humanReviewPassRate !== null &&
    humanReviewPassRate >= 0.9;
  const failures = [
    ...(coverage.complete ? [] : ['COVERAGE_INCOMPLETE']),
    ...(duplicateCaseIds.length === 0 ? [] : ['DUPLICATE_CASE']),
    ...(unexpectedCaseIds.length === 0 ? [] : ['UNEXPECTED_CASE']),
    ...(criticalViolations === 0 ? [] : ['CRITICAL_VIOLATIONS']),
    ...(versions.complete ? [] : ['VERSION_INCOMPLETE']),
    ...(humanReviewCount === cases.length ? [] : ['HUMAN_REVIEW_INCOMPLETE']),
    ...(humanReviewPassRate === null || humanReviewPassRate < 0.9
      ? ['HUMAN_REVIEW_BELOW_THRESHOLD']
      : []),
  ];

  return {
    schemaVersion: MODEL_EVAL_SCHEMA_VERSION,
    coverage,
    assessments,
    metrics,
    versions,
    gates: {
      coverage: coverage.complete,
      criticalViolations,
      humanReviewCount,
      humanReviewPassRate,
      humanReview,
      passed:
        coverage.complete &&
        versions.complete &&
        criticalViolations === 0 &&
        assessments.length === cases.length &&
        assessments.every((assessment) => assessment.passed) &&
        humanReview,
      failures,
    },
  };
};
