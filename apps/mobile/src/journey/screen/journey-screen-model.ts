import type { PublicCard } from '@ima/contracts';
import type { AssistantResponseState } from '@mobile/journey/state/assistant-response';
import {
  selectJourneyCandidateOrder,
  type JourneyActionState,
} from '@mobile/journey/state/journey-actions';
import type { JourneySubmitContext } from '@mobile/journey/screen/journey-screen-props';

/** Build the displayed context from the action result, including a just-skipped candidate. */
export const submitContextFor = (
  input: Pick<JourneySubmitContext, 'conditions' | 'removedChipLabels' | 'cardSetId'>,
  state: JourneyActionState,
  candidateIds: readonly string[],
): JourneySubmitContext => ({
  ...input,
  promotedCandidateId: state.promotedCandidateId,
  selectedCandidateId: state.decidedCandidateId,
  candidateOrder: selectJourneyCandidateOrder(
    candidateIds,
    state.promotedCandidateId,
    state.tonightExcludedCandidateIds,
  ),
  excludeCandidateIds: [...state.tonightExcludedCandidateIds],
});

export const selectedCardFor = (
  responseState: AssistantResponseState,
  candidateId: string | null,
): PublicCard | null => {
  if (responseState.cards === null || candidateId === null) return null;
  return (
    [responseState.cards.hero, ...responseState.cards.alts].find(
      (card) => card.candidateId === candidateId,
    ) ?? null
  );
};
