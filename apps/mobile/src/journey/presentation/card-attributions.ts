import type { PublicCard } from '@ima/contracts';
import {
  collectAttributions,
  dedupeAttributions,
  type AttributionPresentation,
} from '@mobile/ui/presentation/attribution';
import {
  collectPhotoAttributions,
  presentFact,
} from '@mobile/journey/components/candidates/candidate-card-model';

/** Photo attribution repeats the provider the other fields already cite; key on unique sources. */
export const cardAttributions = (card: PublicCard): readonly AttributionPresentation[] =>
  dedupeAttributions([
    ...collectAttributions([
      presentFact(card.facts.identity, (value) => value.name).evidence,
      presentFact(card.facts.opening_hours, () => '').evidence,
      presentFact(card.facts.price, () => '').evidence,
      presentFact(card.facts.facilities, () => '').evidence,
    ]),
    ...collectPhotoAttributions(card),
  ]);

/** A common footer names each credit once; distinct shop links remain in each detail sheet. */
export const resultAttributions = (
  cards: readonly PublicCard[],
): readonly AttributionPresentation[] => {
  const credits = new Map<string, string | null>();
  for (const { label, sourceLink } of cards.flatMap(cardAttributions)) {
    if (!credits.has(label)) credits.set(label, sourceLink);
    else if (credits.get(label) !== sourceLink) credits.set(label, null);
  }
  return [...credits].map(([label, sourceLink]) => ({ label, sourceLink }));
};
