import type { PublicCard } from '@ima/contracts';
import type { JourneyShareAttribution, JourneyShareCandidate } from './journey-share';

const usableIdentity = (card: PublicCard): { readonly name: string } | null => {
  const field = card.facts.identity;
  if (field.status !== 'known') return null;
  return field.evidence.every((item) => item.retention.displayPolicyStatus === 'available')
    ? { name: field.value.name }
    : null;
};

const usableWalkingSeconds = (card: PublicCard): number | null => {
  const field = card.facts.walking_route;
  if (field?.status !== 'known') return null;
  return field.evidence.every((item) => item.retention.displayPolicyStatus === 'available')
    ? field.value.durationSeconds
    : null;
};

const usableMapUrl = (card: PublicCard): string | null => {
  const field = card.facts.contact;
  if (field?.status !== 'known') return null;
  return field.evidence.every((item) => item.retention.displayPolicyStatus === 'available')
    ? field.value.mapUrl
    : null;
};

const usableAttributions = (card: PublicCard): readonly JourneyShareAttribution[] => {
  const fields = [card.facts.identity, card.facts.walking_route, card.facts.contact];
  const facts = fields.flatMap((field) => {
    if (field?.status !== 'known') return [];
    return field.evidence
      .filter((item) => item.retention.displayPolicyStatus === 'available')
      .flatMap((item) =>
        item.attribution === null
          ? []
          : [{ label: item.attribution.label, sourceLink: item.attribution.sourceLink }],
      );
  });
  const text = [card.why, card.diff]
    .filter((value): value is NonNullable<typeof value> => value !== undefined)
    .filter((value) => value.retention.displayPolicyStatus === 'available')
    .flatMap((value) =>
      value.evidence
        .filter((item) => item.retention.displayPolicyStatus === 'available')
        .flatMap((item) =>
          item.attribution === null
            ? []
            : [{ label: item.attribution.label, sourceLink: item.attribution.sourceLink }],
        ),
    );
  return [...facts, ...text];
};

export const journeyShareInputFor = (card: PublicCard): JourneyShareCandidate => ({
  name: usableIdentity(card)?.name ?? '',
  walkingDurationSeconds: usableWalkingSeconds(card),
  mapUrl: usableMapUrl(card),
  attributions: usableAttributions(card),
});
