import type { PublicCard } from '@ima/contracts';
import {
  presentCardFacts,
  presentFact,
} from '@mobile/journey/components/candidates/candidate-card-model';

/** Summary cards omit absent facts; details keep failures and unsupported facts distinguishable. */
export const candidateDetails = (card: PublicCard) => {
  const facts = presentCardFacts(card);
  const rows = [
    {
      label: '所在地',
      fact: presentFact(card.facts.identity, (value) => value.address ?? value.area),
    },
    {
      label: 'アクセス',
      fact: presentFact(
        card.facts.identity,
        (value) => value.accessText ?? value.stationName ?? '',
      ),
    },
    { label: '営業時間', fact: facts.openingHours },
    { label: '予算', fact: facts.price },
    { label: '終電', fact: facts.lastTrain },
  ].filter(({ fact }) => fact.status !== 'missing' && fact.label.length > 0);
  const source = presentFact(card.facts.identity, (value) => value.sourceUrl ?? '');
  return {
    rows,
    sourceUrl: source.status === 'known' && source.label.length > 0 ? source.label : null,
  };
};
