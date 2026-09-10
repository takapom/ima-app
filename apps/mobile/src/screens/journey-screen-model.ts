import type { PublicCard } from '@ima/contracts';
import type { AssistantResponseState } from '../state/assistant-response';

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
