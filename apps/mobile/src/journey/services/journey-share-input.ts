import type { EvidenceRef, PublicCard } from '@ima/contracts';
import { collectAttributions } from '@mobile/ui/presentation/attribution';
import { placePageUrlFor } from '@mobile/journey/services/journey-map';
import type {
  JourneyShareAttribution,
  JourneyShareCandidate,
} from '@mobile/journey/services/journey-share';

const usableIdentity = (card: PublicCard): { readonly name: string } | null => {
  const field = card.facts.identity;
  if (field.status !== 'known') return null;
  return field.evidence.every((item) => item.retention.displayPolicyStatus === 'available')
    ? { name: field.value.name }
    : null;
};

/**
 * A contact map link stays preferred, but a provider that withholds contact still
 * leaves the identity place page, so sharing never loses its destination link.
 */
const usableMapUrl = (card: PublicCard): string | null => {
  const field = card.facts.contact;
  const contactMapUrl =
    field?.status === 'known' &&
    field.evidence.every((item) => item.retention.displayPolicyStatus === 'available')
      ? field.value.mapUrl
      : null;
  return contactMapUrl ?? placePageUrlFor(card);
};

/**
 * Shares the same attribution projection the card UI uses, so a SourceRef credit
 * cannot reach the screen while being dropped from the shared text. Evidence whose
 * display policy is not available is excluded before the projection runs.
 */
const usableAttributions = (card: PublicCard): readonly JourneyShareAttribution[] => {
  const displayable = (evidence: readonly EvidenceRef[]): readonly EvidenceRef[] =>
    evidence.filter((item) => item.retention.displayPolicyStatus === 'available');
  const fields = [card.facts.identity, card.facts.contact];
  const facts = fields.flatMap((field) =>
    field?.status === 'known' ? [displayable(field.evidence)] : [],
  );
  const text = [card.why, card.diff]
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .filter((value) => value.retention.displayPolicyStatus === 'available')
    .map((value) => displayable(value.evidence));
  return collectAttributions([...facts, ...text]);
};

export const journeyShareInputFor = (card: PublicCard): JourneyShareCandidate => ({
  name: usableIdentity(card)?.name ?? '',
  mapUrl: usableMapUrl(card),
  attributions: usableAttributions(card),
});
