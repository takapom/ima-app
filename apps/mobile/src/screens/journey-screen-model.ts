import type { PublicCard } from '@ima/contracts';
import type { AssistantResponseState } from '@mobile/state/assistant-response';
import {
  selectJourneyCandidateOrder,
  type JourneyActionState,
} from '@mobile/state/journey-actions';
import type { JourneySubmitContext } from '@mobile/screens/journey-screen-props';

/** Build the displayed context from the action result, including a just-skipped candidate. */
export const submitContextFor = (
  input: Pick<
    JourneySubmitContext,
    'conditions' | 'removedChipLabels' | 'cardSetId' | 'savedPlaceRefs'
  >,
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
