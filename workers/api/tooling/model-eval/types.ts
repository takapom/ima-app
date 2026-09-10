export const MODEL_EVAL_SCHEMA_VERSION = 'm25.v1' as const;
export const MODEL_EVAL_REPEATS = 3 as const;

export type EvalPattern =
  | 'new-search'
  | 'condition-change'
  | 'reason'
  | 'compare'
  | 'specific-place'
  | 'decide-action'
  | 'clarify-ambiguity'
  | 'candidate-failure';

export type ScenarioId =
  | EvalPattern
  | 'mixed-intent'
  | 'prompt-injection'
  | 'continuity'
  | 'repair'
  | 'gps-refusal'
  | 'saved-place-reference';

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type Evidence = {
  readonly id: string;
  readonly subjectId: string;
  readonly field: string;
  readonly value: JsonValue;
  readonly source: 'provider' | 'user' | 'system';
  readonly freshUntil: string | null;
};

export type Candidate = {
  readonly id: string;
  readonly displayName: string;
};

export type ScenarioContext = {
  readonly now: string;
  readonly candidates: readonly Candidate[];
  readonly evidence: readonly Evidence[];
  readonly orderedCandidateIds: readonly string[];
  readonly selectedCandidateId: string | null;
  readonly savedPlaceRefs: readonly string[];
  readonly activeConditions: readonly { readonly field: string; readonly value: JsonValue }[];
  readonly locationPolicy: 'refuse-to-model' | 'available-to-tool';
  readonly locationStatus: 'available' | 'denied' | 'unavailable';
};

export type ExpectedOutcome = 'message' | 'cards' | 'clarification' | 'partial';

export type ForbiddenBehavior =
  | 'unnecessary-search'
  | 'over-confirmation'
  | 'condition-dropped'
  | 'candidate-confusion'
  | 'unsupported-claim'
  | 'unsupported-capability'
  | 'prompt-injection-followed'
  | 'gps-disclosure'
  | 'expired-evidence'
  | 'saved-candidate-lost'
  | 'repair-not-applied';

export type ExpectedBehavior = {
  readonly outcomes: readonly ExpectedOutcome[];
  readonly requiredCandidateIds: readonly string[];
  readonly requiredSavedPlaceRefs: readonly string[];
  readonly preserveConditionFields: readonly string[];
  readonly requiredSignals: readonly string[];
  readonly forbidden: readonly ForbiddenBehavior[];
  readonly mustNotSearch: boolean;
  readonly mustPreserveCandidates: boolean;
  readonly mustRefuseLocation: boolean;
};

export type EvaluationScenario = {
  readonly id: ScenarioId;
  readonly pattern: EvalPattern;
  readonly title: string;
  readonly userTurns: readonly string[];
  readonly context: ScenarioContext;
  readonly expected: ExpectedBehavior;
};

export type EvaluationCase = EvaluationScenario & {
  readonly caseId: string;
  readonly repeat: 1 | 2 | 3;
};

export type ResponseOutcome = {
  readonly kind: ExpectedOutcome;
  readonly text: string;
};

export type EvidenceClaim = {
  readonly id: string;
  readonly subjectId: string;
  readonly field: string;
  readonly assertedValue: JsonValue;
  readonly evidenceIds: readonly string[];
  readonly text: string;
};

export type CandidateSelection = {
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
  readonly why: string;
};

export type ToolCall = {
  readonly name: 'search_places' | 'get_place_details' | 'submit_cards';
  readonly candidateIds: readonly string[];
};

export type ObservedForbiddenBehavior = {
  readonly kind: ForbiddenBehavior;
  readonly detail: string;
};

export type EvaluationResponse = {
  readonly outcome: ResponseOutcome;
  readonly claims: readonly EvidenceClaim[];
  readonly selections: readonly CandidateSelection[];
};

export type EvaluationTrace = {
  readonly complete: boolean;
  readonly toolCalls: readonly ToolCall[];
  readonly forbiddenBehaviors: readonly ObservedForbiddenBehavior[];
  readonly modelLocationExposed: boolean;
  readonly selectedCandidateIds: readonly string[];
  readonly resolvedSavedPlaceRefs: readonly string[];
  readonly preservedConditionFields: readonly string[];
  readonly candidateSetChanges: readonly {
    readonly candidateId: string;
    readonly action: 'added' | 'removed' | 'replaced';
    readonly userRequested: boolean;
  }[];
};

export type EvaluationMetrics = {
  readonly latencyMs: number | null;
  readonly modelCalls: number | null;
  readonly toolCalls: number | null;
  readonly upstreamCalls: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly measuredCostUsd: number | null;
};

export type HumanReview = {
  readonly requestSatisfied: 1 | 2 | 3 | 4 | 5;
  readonly groundedness: 1 | 2 | 3 | 4 | 5;
  readonly clarity: 1 | 2 | 3 | 4 | 5;
  readonly requiredSignals: readonly { readonly signal: string; readonly satisfied: boolean }[];
  readonly criticalViolations: readonly string[];
};

export type EvaluationRun = {
  readonly schemaVersion: typeof MODEL_EVAL_SCHEMA_VERSION;
  readonly scenarioId: ScenarioId;
  readonly repeat: 1 | 2 | 3;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly response: EvaluationResponse;
  readonly trace: EvaluationTrace;
  readonly metrics: EvaluationMetrics;
  readonly humanReview?: HumanReview;
};

export type CriticalViolation =
  | 'schema-invalid'
  | 'wrong-outcome'
  | 'missing-grounding'
  | 'unsupported-claim'
  | 'expired-evidence'
  | 'candidate-misidentification'
  | 'forbidden-behavior'
  | 'trace-incomplete'
  | 'human-critical-violation'
  | 'missing-continuity-reference';

export type RunAssessment = {
  readonly caseId: string;
  readonly scenarioId: ScenarioId;
  readonly repeat: 1 | 2 | 3;
  readonly passed: boolean;
  readonly criticalViolations: readonly CriticalViolation[];
  readonly humanReviewPassed: boolean | null;
  readonly humanReviewMissing: boolean;
};

export type MetricSummary = {
  readonly samples: number;
  readonly unknown: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly total: number | null;
};

export type CostSummary = {
  readonly knownSamples: number;
  readonly unknownSamples: number;
  readonly totalUsd: number | null;
  readonly averageUsd: number | null;
};

export type EvaluationReport = {
  readonly schemaVersion: typeof MODEL_EVAL_SCHEMA_VERSION;
  readonly coverage: {
    readonly expected: number;
    readonly actual: number;
    readonly missingCaseIds: readonly string[];
    readonly duplicateCaseIds: readonly string[];
    readonly unexpectedCaseIds: readonly string[];
    readonly complete: boolean;
  };
  readonly assessments: readonly RunAssessment[];
  readonly metrics: {
    readonly latencyMs: MetricSummary;
    readonly modelCalls: MetricSummary;
    readonly toolCalls: MetricSummary;
    readonly upstreamCalls: MetricSummary;
    readonly inputTokens: MetricSummary;
    readonly outputTokens: MetricSummary;
    readonly costUsd: CostSummary;
  };
  readonly versions: {
    readonly modelVersions: readonly string[];
    readonly promptVersions: readonly string[];
    readonly complete: boolean;
  };
  readonly gates: {
    readonly coverage: boolean;
    readonly criticalViolations: number;
    readonly humanReviewCount: number;
    readonly humanReviewPassRate: number | null;
    readonly humanReview: boolean;
    readonly passed: boolean;
    readonly failures: readonly string[];
  };
};
