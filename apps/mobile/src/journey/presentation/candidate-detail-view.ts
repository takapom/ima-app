import type { FacilitiesInfo, PublicCard } from '@ima/contracts';
import {
  normalizeWidth,
  readField,
  toCardViewModel,
  type CardOpening,
  type CardVisual,
} from '@mobile/journey/presentation/candidate-card-view';
import {
  collectAttributions,
  dedupeAttributions,
  type AttributionPresentation,
} from '@mobile/ui/presentation/attribution';
import {
  isPhotoImageReadyFor,
  photoDeadline,
  photoExpiryDeadline,
  type ReadyPhotoImage,
} from '@mobile/journey/state/photo-image-state';

export type DetailFacility = {
  readonly label: string;
  readonly value: 'yes' | 'no' | 'partial';
};

export type CandidateDetailViewModel = {
  readonly candidateId: string;
  readonly name: string;
  readonly category: string | null;
  readonly visual: CardVisual;
  readonly opening: CardOpening;
  readonly hours: readonly string[];
  readonly station: string | null;
  readonly access: string | null;
  readonly address: string | null;
  readonly price: string | null;
  readonly facilities: readonly DetailFacility[];
  readonly facilityNotes: readonly string[];
  readonly primaryAction: 'decide' | 'save';
  readonly dimmed: boolean;
  readonly attributions: readonly AttributionPresentation[];
};

const text = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim().length === 0 ? null : normalizeWidth(value);

const detailFacilities = (facilities: FacilitiesInfo | null): readonly DetailFacility[] => {
  if (facilities === null) return [];
  const values = [
    { label: '全面禁煙', value: facilities.nonSmoking },
    { label: 'Wi-Fi', value: facilities.wifi },
    { label: '個室', value: facilities.privateRoom },
    { label: '駐車場', value: facilities.parking },
  ];
  return values.flatMap(({ label, value }) => (value === 'unknown' ? [] : [{ label, value }]));
};

/** Only facts displayed by this sheet contribute credits; explanation text is not a source. */
const detailAttributions = (card: PublicCard): readonly AttributionPresentation[] => {
  const fields = [
    card.facts.identity,
    card.facts.opening_hours,
    card.facts.price,
    card.facts.facilities,
    card.facts.photos,
  ];
  const evidence = fields.flatMap((field) =>
    field?.status === 'known' && readField<unknown>(field) !== null ? [field.evidence] : [],
  );
  const photos = readField(card.facts.photos);
  return dedupeAttributions([
    ...collectAttributions(evidence),
    ...(photos?.photos.flatMap((photo) =>
      photo.attributions.map((credit) => ({ label: credit.displayName, sourceLink: credit.uri })),
    ) ?? []),
  ]).filter((credit) => credit.label.trim().length > 0);
};

/** All fact and action decisions use the same retention and opening rules as the card. */
export const toCandidateDetailViewModel = (
  card: PublicCard,
  now: number,
): CandidateDetailViewModel => {
  const summary = toCardViewModel(card, now);
  const identity = readField(card.facts.identity);
  const facilities = readField(card.facts.facilities);
  return {
    candidateId: card.candidateId,
    name: summary.name,
    category: text(identity?.category),
    visual: summary.visual,
    opening: summary.opening,
    hours: readField(card.facts.opening_hours)?.weeklyText.filter((entry) => entry.trim()) ?? [],
    station: text(identity?.stationName),
    access: text(identity?.accessText),
    address: text(identity?.address),
    price: text(readField(card.facts.price)?.rawLabel),
    facilities: detailFacilities(facilities),
    facilityNotes: facilities?.sourceText.flatMap((entry) => text(entry) ?? []).slice(0, 4) ?? [],
    primaryAction: summary.opening.kind === 'closed' ? 'save' : 'decide',
    dimmed: summary.dimmed,
    attributions: detailAttributions(card),
  };
};

export const detailSections = (view: CandidateDetailViewModel) => {
  const values = [
    { label: '営業時間', lines: view.hours },
    { label: '駅', lines: view.station === null ? [] : [view.station] },
    { label: 'アクセス', lines: view.access === null ? [] : [view.access] },
    { label: '住所', lines: view.address === null ? [] : [view.address] },
    { label: '予算', lines: view.price === null ? [] : [view.price] },
    {
      label: '設備',
      lines: view.facilities.map(
        ({ label, value }) =>
          `${label}：${{ yes: 'あり', no: 'なし', partial: '一部対応' }[value]}`,
      ),
    },
    { label: '設備の補足', lines: view.facilityNotes },
  ];
  return values.filter((section) => section.lines.length > 0);
};

export const detailActions = (view: CandidateDetailViewModel) => {
  const decide = { kind: 'decide', label: 'ここにする' } as const;
  const save = { kind: 'save', label: '残す' } as const;
  return view.primaryAction === 'save' ? [save, decide] : [decide, save];
};

/** Shared images are references to mounted card state, never a second loader or disk cache. */
export const candidateDetailPhotos = (
  card: PublicCard,
  images: readonly ReadyPhotoImage[],
  client: object | undefined,
  now: number,
): readonly ReadyPhotoImage[] => {
  const field = card.facts.photos;
  const photos = readField(field);
  if (photos === null || field?.status !== 'known' || client === undefined) return [];
  const displayUntil = photoDeadline(field.evidence);
  return photos.photos.flatMap(({ photoToken: token }) => {
    const image = images.find((candidate) => {
      const deadline = photoExpiryDeadline(candidate.asset, displayUntil);
      return (
        isPhotoImageReadyFor(candidate, { client, token, displayUntil }) &&
        deadline !== null &&
        now < deadline
      );
    });
    return image === undefined ? [] : [image];
  });
};
