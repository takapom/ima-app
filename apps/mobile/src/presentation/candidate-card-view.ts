import type {
  EvidenceRef,
  FacilitiesInfo,
  OpeningHours,
  PlaceIdentity,
  PriceInfo,
  PublicCard,
  WalkingRoute,
} from '@ima/contracts';

/**
 * Minutes remaining at or below which the card escalates to the closing-soon treatment.
 * The escalation is the card's only state-driven emphasis, so the threshold lives here
 * rather than in the component.
 */
export const CLOSING_SOON_MINUTES = 30;

export type CardVisual = 'photo' | 'typographic';

/**
 * Opening state resolved against the render clock, never against `evaluatedAt`.
 * `listedOpenAtEvaluation` is a snapshot taken when the Worker committed the card and
 * goes stale the moment the reader keeps the screen open, so it is deliberately unused.
 */
export type CardOpening =
  | { readonly kind: 'none' }
  | { readonly kind: 'listed'; readonly text: string }
  | {
      readonly kind: 'open' | 'closing';
      readonly closesAtLabel: string;
      readonly remainingMinutes: number;
      readonly lastOrderLabel: string | null;
    }
  | { readonly kind: 'closed'; readonly reopensAtLabel: string | null };

export type CardViewModel = {
  readonly candidateId: string;
  readonly name: string;
  readonly category: string | null;
  readonly visual: CardVisual;
  readonly opening: CardOpening;
  /** Null means the line is not rendered at all; absence never becomes a placeholder row. */
  readonly access: string | null;
  readonly price: string | null;
  readonly amenities: readonly string[];
  readonly diff: string | null;
  readonly primaryAction: 'decide' | 'save';
  readonly dimmed: boolean;
};

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
  | { readonly status: 'error'; readonly code: string; readonly reason: string };

type DisplayFieldLike<T> = KnownField<T> | UnavailableField;

/** Resolves the render clock; hosts and tests inject an ISO string, production uses the device. */
export const cardRenderNow = (now: string | undefined): number => {
  if (now === undefined) return Date.now();
  const at = Date.parse(now);
  return Number.isFinite(at) ? at : Date.now();
};

/**
 * Yields the value only when the field is known AND every piece of its evidence is still
 * displayable. A withheld or expired field is treated as absent so no stale value renders.
 */
const readField = <T>(field: DisplayFieldLike<T> | undefined): T | null => {
  if (field === undefined || field.status !== 'known') return null;
  const withheld = field.evidence.some(
    (evidence) => evidence.retention.displayPolicyStatus !== 'available',
  );
  return withheld ? null : field.value;
};

/** Provider access text mixes full-width Latin (`ＪＲ`) into half-width prose; even it out. */
const normalizeWidth = (value: string): string =>
  value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

const intlOrNull = (build: () => Intl.DateTimeFormat): Intl.DateTimeFormat | null => {
  try {
    return build();
  } catch {
    return null;
  }
};

const formatClock = (iso: string, timeZone: string): string | null => {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const formatter = intlOrNull(
    () =>
      new Intl.DateTimeFormat('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
      }),
  );
  return formatter === null ? null : formatter.format(new Date(at));
};

/** Civil date in the venue's zone, as YYYY-MM-DD, for same-day / next-day comparison. */
const civilDay = (at: number, timeZone: string): string | null => {
  const formatter = intlOrNull(
    () =>
      new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone,
      }),
  );
  return formatter === null ? null : formatter.format(new Date(at));
};

const dayPrefix = (now: number, target: number, timeZone: string): string => {
  const today = civilDay(now, timeZone);
  const targetDay = civilDay(target, timeZone);
  if (today === null || targetDay === null || today === targetDay) return '';
  if (targetDay === civilDay(now + 86_400_000, timeZone)) return '明日 ';
  const [, month, day] = targetDay.split('-');
  return month === undefined || day === undefined ? '' : `${Number(month)}/${Number(day)} `;
};

/** `endAt: null` is the provider's open-ended interval, so it never closes on its own. */
const isOpenAt = (intervals: OpeningHours['intervals'], now: number): boolean =>
  intervals.some((interval) => {
    const startAt = Date.parse(interval.startAt);
    if (!Number.isFinite(startAt) || now < startAt) return false;
    if (interval.endAt === null) return true;
    const endAt = Date.parse(interval.endAt);
    return Number.isFinite(endAt) && now < endAt;
  });

const listedOpening = (hours: OpeningHours): CardOpening => {
  const text = hours.weeklyText.find((entry) => entry.length > 0);
  return text === undefined ? { kind: 'none' } : { kind: 'listed', text };
};

const lastOrderLabel = (hours: OpeningHours): string | null => {
  if (hours.lastOrderRaw !== null && hours.lastOrderRaw.length > 0) return hours.lastOrderRaw;
  return hours.lastOrderAt === null ? null : formatClock(hours.lastOrderAt, hours.timeZone);
};

const resolveOpening = (hours: OpeningHours | null, now: number): CardOpening => {
  if (hours === null) return { kind: 'none' };
  // No parsed boundary means the hours were never turned into instants; show the listed
  // text as published instead of naming a time the data cannot support.
  if (hours.nextBoundaryAt === null) return listedOpening(hours);
  const boundary = Date.parse(hours.nextBoundaryAt);
  if (!Number.isFinite(boundary)) return listedOpening(hours);

  if (!isOpenAt(hours.intervals, now)) {
    const clock = formatClock(hours.nextBoundaryAt, hours.timeZone);
    return {
      kind: 'closed',
      reopensAtLabel: clock === null ? null : `${dayPrefix(now, boundary, hours.timeZone)}${clock}`,
    };
  }

  const closesAtLabel = formatClock(hours.nextBoundaryAt, hours.timeZone);
  if (closesAtLabel === null) return listedOpening(hours);
  const remainingMinutes = Math.max(0, Math.round((boundary - now) / 60_000));
  return {
    kind: remainingMinutes <= CLOSING_SOON_MINUTES ? 'closing' : 'open',
    closesAtLabel,
    remainingMinutes,
    lastOrderLabel: lastOrderLabel(hours),
  };
};

const resolveAccess = (
  identity: PlaceIdentity | null,
  route: WalkingRoute | null,
): string | null => {
  const station = identity?.stationName ?? null;
  if (route !== null) {
    const minutes = Math.max(1, Math.round(route.durationSeconds / 60));
    return station === null
      ? `徒歩${minutes}分`
      : `${normalizeWidth(station)}駅から徒歩${minutes}分`;
  }
  const accessText = identity?.accessText ?? null;
  if (accessText !== null && accessText.length > 0) return normalizeWidth(accessText);
  return station === null ? null : `${normalizeWidth(station)}駅`;
};

/** Only the provider's own label or an explicit range renders; a bare level says nothing useful. */
const resolvePrice = (price: PriceInfo | null): string | null => {
  if (price === null) return null;
  if (price.rawLabel !== null && price.rawLabel.length > 0) return normalizeWidth(price.rawLabel);
  const range = price.range;
  if (range === null) return null;
  const amount =
    range.min === range.max
      ? `${range.min.toLocaleString('ja-JP')}円`
      : `${range.min.toLocaleString('ja-JP')}〜${range.max.toLocaleString('ja-JP')}円`;
  return range.unit === 'per_person' ? `${amount}/人` : amount;
};

const resolveAmenities = (facilities: FacilitiesInfo | null): readonly string[] => {
  if (facilities === null) return [];
  const chips: string[] = [];
  if (facilities.nonSmoking === 'yes') chips.push('全面禁煙');
  else if (facilities.nonSmoking === 'partial') chips.push('分煙');
  if (facilities.wifi === 'yes') chips.push('Wi-Fi');
  if (facilities.privateRoom === 'yes') chips.push('個室');
  if (facilities.parking === 'yes') chips.push('駐車場');
  return chips;
};

const resolveDiff = (diff: PublicCard['diff']): string | null => {
  if (diff === undefined || diff.retention.displayPolicyStatus !== 'available') return null;
  return diff.basis === 'inference' ? `推定: ${diff.text}` : diff.text;
};

const resolveVisual = (card: PublicCard): CardVisual => {
  const photos = readField(card.facts.photos);
  return photos !== null && photos.photos.length > 0 ? 'photo' : 'typographic';
};

/**
 * The single decision point for which card treatment renders. Every branch is a function of
 * the DTO plus the render clock, so the whole state space is enumerable in tests and no
 * upstream component or model chooses a layout.
 */
export const toCardViewModel = (card: PublicCard, now: number): CardViewModel => {
  const identity = readField(card.facts.identity);
  const opening = resolveOpening(readField(card.facts.opening_hours), now);
  return {
    candidateId: card.candidateId,
    name: identity?.name ?? '候補',
    category: identity?.category ?? null,
    visual: resolveVisual(card),
    opening,
    access: resolveAccess(identity, readField(card.facts.walking_route)),
    price: resolvePrice(readField(card.facts.price)),
    amenities: resolveAmenities(readField(card.facts.facilities)),
    diff: resolveDiff(card.diff),
    primaryAction: opening.kind === 'closed' ? 'save' : 'decide',
    dimmed: opening.kind === 'closed',
  };
};
