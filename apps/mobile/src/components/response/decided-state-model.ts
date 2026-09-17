import type { PublicCard } from '@ima/contracts';
import { presentFact } from '@mobile/components/candidates/candidate-card-model';

export const presentDecidedIdentity = (card: PublicCard | null) => {
  if (card === null || card.facts.identity.status !== 'known') return null;
  return presentFact(card.facts.identity, (value) => value.name).status === 'known'
    ? card.facts.identity.value
    : null;
};
