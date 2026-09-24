import { expandEvaluationDataset } from '../../tooling/model-eval/dataset';
import { MODEL_EVAL_SHOPS } from '../../tooling/model-eval/fixture-shops';
import type {
  EvaluationCase,
  EvaluationRun,
  EvidenceClaim,
  ExpectedOutcome,
} from '../../tooling/model-eval/types';

const evidenceForCandidate = (candidateId: string): readonly string[] => [
  `${candidateId.replace('candidate-', 'ev-')}-identity`,
];

const nameFor = (candidateId: string): string => {
  const shop = MODEL_EVAL_SHOPS.find((entry) => entry.candidateId === candidateId);
  if (shop === undefined) throw new Error(`unknown candidate: ${candidateId}`);
  return shop.wire.name;
};

const claimForCandidate = (candidateId: string): EvidenceClaim => ({
  id: `claim-${candidateId}`,
  subjectId: candidateId,
  field: 'identity',
  assertedValue: { name: nameFor(candidateId) },
  evidenceIds: evidenceForCandidate(candidateId),
  text: '観測された候補名',
});

export const outcomeFor = (evaluationCase: EvaluationCase): ExpectedOutcome => {
  const outcome = evaluationCase.expected.outcomes[0];
  if (outcome === undefined) throw new Error(`scenario has no outcome: ${evaluationCase.id}`);
  return outcome;
};

export const validRun = (evaluationCase: EvaluationCase): EvaluationRun => ({
  schemaVersion: 'm25.v2',
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
    preservedConditionFields: evaluationCase.expected.preserveConditionFields,
    candidateSetChanges: [],
  },
  metrics: {
    latencyMs: 100 + evaluationCase.repeat,
    turnMs: 150 + evaluationCase.repeat,
    modelCalls: 1,
    toolCalls: 1,
    executedTools: { search_places: 0, get_place_details: 0, respond: 1 },
    respondInvalid: 0,
    respondKind:
      outcomeFor(evaluationCase) === 'cards'
        ? 'propose'
        : outcomeFor(evaluationCase) === 'clarification'
          ? 'ask'
          : 'answer',
    upstreamCalls: 0,
    inputTokens: 100,
    cachedInputTokens: 40,
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

export const allValidRuns = (): readonly EvaluationRun[] => expandEvaluationDataset().map(validRun);
