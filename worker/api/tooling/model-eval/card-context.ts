import type { LiveProbeProfile } from './live';
import type { CandidateIdentityMapping } from './candidate-mapping';
import type { EvaluationCase } from './types';
import type { EvaluationCardContext } from './scenario-input';

export type LiveCardContextValidation =
  | { readonly ok: true; readonly context: EvaluationCardContext }
  | {
      readonly ok: false;
      readonly code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' | 'PRELUDE_CARD_SET_UNAVAILABLE';
    };

const minimumCandidatesFor = (profile: LiveProbeProfile): number =>
  profile === 'reason' ||
  profile === 'specific-place' ||
  profile === 'decide-action' ||
  profile === 'repair'
    ? 1
    : 2;

/** Validates formal card state and translates dataset IDs only through captured identities. */
export const validateLiveCardContext = (input: {
  readonly profile: LiveProbeProfile;
  readonly evaluationCase: EvaluationCase;
  readonly cardContext: EvaluationCardContext;
  readonly mapping: CandidateIdentityMapping | undefined;
}): LiveCardContextValidation => {
  if (input.mapping === undefined) {
    return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' };
  }
  if (input.cardContext.candidateOrder.length < minimumCandidatesFor(input.profile)) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  if (
    input.profile === 'clarify-ambiguity' &&
    (input.evaluationCase.context.selectedCandidateId !== null ||
      input.cardContext.selectedCandidateId !== null)
  ) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  if (
    input.cardContext.candidateOrder.some(
      (runtimeCandidateId) => !input.mapping?.byRuntimeCandidateId.has(runtimeCandidateId),
    )
  ) {
    return { ok: false, code: 'CANDIDATE_ID_MAPPING_UNAVAILABLE' };
  }
  const runtimeForEvaluation = (evaluationCandidateId: string): string | undefined =>
    input.mapping?.pairs.find((pair) => pair.evaluationCandidateId === evaluationCandidateId)
      ?.runtimeCandidateId;
  if (
    input.evaluationCase.expected.requiredCandidateIds.some((evaluationCandidateId) => {
      const runtimeCandidateId = runtimeForEvaluation(evaluationCandidateId);
      return (
        runtimeCandidateId === undefined ||
        !input.cardContext.candidateOrder.includes(runtimeCandidateId)
      );
    })
  ) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  if (
    input.profile === 'continuity' &&
    input.mapping.byRuntimeCandidateId.get(input.cardContext.candidateOrder[1] ?? '') !==
      input.evaluationCase.expected.requiredCandidateIds[0]
  ) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  const selectedEvaluationId = input.evaluationCase.context.selectedCandidateId;
  if (selectedEvaluationId === null) return { ok: true, context: input.cardContext };
  const selectedRuntimeId = runtimeForEvaluation(selectedEvaluationId);
  if (
    selectedRuntimeId === undefined ||
    !input.cardContext.candidateOrder.includes(selectedRuntimeId)
  ) {
    return { ok: false, code: 'PRELUDE_CARD_SET_UNAVAILABLE' };
  }
  return {
    ok: true,
    context: { ...input.cardContext, selectedCandidateId: selectedRuntimeId },
  };
};
