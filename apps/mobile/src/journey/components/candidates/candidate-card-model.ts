import type { EvidenceRef, OpeningHours, PriceInfo, PublicCard } from '@ima/contracts';
import type { AttributionPresentation } from '@mobile/ui/presentation/attribution';

export { collectAttributions } from '@mobile/ui/presentation/attribution';
export type { AttributionPresentation } from '@mobile/ui/presentation/attribution';

type KnownField<T> = {
  readonly status: 'known';
  readonly value: T;
  readonly evidence: readonly EvidenceRef[];
};

type UnavailableField =
  | {
      readonly status: 'unknown' | 'unsupported' | 'not_applicable';
      readonly reason: string;
    }
  | {
      readonly status: 'error';
      readonly code: string;
      readonly reason: string;
    };

type DisplayFieldLike<T> = KnownField<T> | UnavailableField;

export type FactStatus =
  | 'missing'
  | 'known'
  | 'unknown'
  | 'unsupported'
  | 'not_applicable'
  | 'error'
  | 'expired'
  | 'unavailable';

export type FactPresentation = {
  readonly status: FactStatus;
  readonly label: string;
  readonly evidence: readonly EvidenceRef[];
};

/** Generated text cites nothing; uncertainty is stated in the text itself, not by a label. */
export type GeneratedTextPresentation = {
  readonly status: 'available' | 'expired' | 'unavailable';
  readonly text: string;
};

const fieldStatusLabel: Record<UnavailableField['status'], string> = {
  unknown: '未確認',
  unsupported: '未対応',
  not_applicable: '対象外',
  error: '取得エラー',
};

const hiddenStatusLabel: Record<string, string> = {
  expired: '表示期限切れ',
  policy_withheld: '表示制限',
  disabled_m35: '表示停止',
  disabled_capability: '表示非対応',
  attribution_missing: '出典不足',
};

export const presentFact = <T>(
  field: DisplayFieldLike<T> | undefined,
  format: (value: T) => string,
): FactPresentation => {
  if (field === undefined) return { status: 'missing', label: '未提供', evidence: [] };
  if (field.status !== 'known') {
    return {
      status: field.status,
      label: `${fieldStatusLabel[field.status]}: ${field.reason}`,
      evidence: [],
    };
  }

  const unavailableEvidence = field.evidence.find(
    (evidence) => evidence.retention.displayPolicyStatus !== 'available',
  );
  if (unavailableEvidence !== undefined) {
    const status = unavailableEvidence.retention.displayPolicyStatus;
    return {
      status: status === 'expired' ? 'expired' : 'unavailable',
      label: hiddenStatusLabel[status] ?? '表示できません',
      evidence: [],
    };
  }

  return { status: 'known', label: format(field.value), evidence: field.evidence };
};

export const presentGeneratedText = (value: PublicCard['why']): GeneratedTextPresentation => {
  const displayPolicyStatus = value.retention.displayPolicyStatus;
  if (displayPolicyStatus !== 'available') {
    return {
      status: displayPolicyStatus === 'expired' ? 'expired' : 'unavailable',
      text:
        displayPolicyStatus === 'expired'
          ? 'この説明は表示期限を過ぎています。'
          : 'この説明は現在表示できません。',
    };
  }

  return { status: 'available', text: value.text };
};

const formatAtZone = (value: string, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('ja-JP', {
      dateStyle: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
};

export const formatOpeningHours = (value: OpeningHours): string => {
  const openStatus =
    value.listedOpenAtEvaluation === null
      ? '営業状況 未確認'
      : value.listedOpenAtEvaluation
        ? '確認時点では営業中'
        : '営業時間外';
  const schedule = value.weeklyText.length > 0 ? value.weeklyText.join(' / ') : '営業時間記載あり';
  const lastOrder = value.lastOrderRaw === null ? null : `L.O. ${value.lastOrderRaw}`;
  const nextBoundary =
    value.nextBoundaryAt === null
      ? null
      : `営業時間の切替 ${formatAtZone(value.nextBoundaryAt, value.timeZone)}`;
  return [openStatus, schedule, lastOrder, nextBoundary, `時間帯 ${value.timeZone}`]
    .filter((part): part is string => part !== null)
    .join(' · ');
};

const formatPrice = (value: PriceInfo): string => {
  if (value.rawLabel !== null) return value.rawLabel;
  if (value.range !== null) {
    const range =
      value.range.min === value.range.max
        ? `${value.range.currency} ${value.range.min}`
        : `${value.range.currency} ${value.range.min}〜${value.range.max}`;
    const unit =
      value.range.unit === 'per_person'
        ? '1人あたり'
        : value.range.unit === 'per_item'
          ? '1品あたり'
          : '単位未確認';
    return `${range} · ${unit}`;
  }
  return value.level === null ? '価格情報あり' : `価格帯レベル ${value.level}`;
};

export const presentCardFacts = (card: PublicCard) => ({
  openingHours: presentFact(card.facts.opening_hours, formatOpeningHours),
  price: presentFact(card.facts.price, formatPrice),
});

export const shouldShowPhotoRegion = (card: PublicCard): boolean => {
  const photos = card.facts.photos;
  return photos?.status === 'known' ? photos.value.photos.length > 0 : photos?.status === 'error';
};

export const collectPhotoAttributions = (card: PublicCard): readonly AttributionPresentation[] => {
  const fact = card.facts.photos;
  const presentation = presentFact(fact, (value) => String(value.photos.length));
  if (fact?.status !== 'known' || presentation.status !== 'known') return [];
  const seen = new Set<string>();
  return fact.value.photos.flatMap((photo) =>
    photo.attributions.flatMap((attribution) => {
      const result = { label: attribution.displayName, sourceLink: attribution.uri };
      const key = `${result.label}|${result.sourceLink ?? ''}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [result];
    }),
  );
};
