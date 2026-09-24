import type { CardsData, EvidenceRef, PublicCard, RetentionMetadata } from '@ima/contracts';
import type { AssistantResponseState } from '@mobile/journey/state/assistant-response';

type DisplayField<T> =
  | {
      readonly status: 'known';
      readonly value: T;
      readonly evidence: EvidenceRef[];
    }
  | {
      readonly status: 'unknown' | 'unsupported' | 'not_applicable';
      readonly reason: string;
    }
  | {
      readonly status: 'error';
      readonly code: 'PROVIDER_UNAVAILABLE' | 'MISSING_EVIDENCE' | 'INTERNAL';
      readonly reason: string;
    };

export type AssistantResponseProjectionNow = string;

const parseNow = (now: AssistantResponseProjectionNow): number => {
  const milliseconds = Date.parse(now);
  if (!Number.isFinite(milliseconds)) {
    throw new Error('assistant response projection now must be an ISO timestamp');
  }
  return milliseconds;
};

const displayExpired = (displayUntil: string | null, now: number): boolean =>
  displayUntil !== null && Date.parse(displayUntil) <= now;

const retentionExpired = (retention: RetentionMetadata, now: number): boolean =>
  [
    retention.displayUntil,
    retention.sessionExpiresAt,
    retention.retentionUntil,
    retention.deletionScheduledAt,
  ].some((deadline) => displayExpired(deadline, now));

const projectRetention = (retention: RetentionMetadata, now: number): RetentionMetadata => {
  if (retention.displayPolicyStatus !== 'available') return retention;
  if (retentionExpired(retention, now)) {
    return { ...retention, displayPolicyStatus: 'expired' };
  }
  return retention;
};

const projectEvidence = (value: EvidenceRef, now: number): EvidenceRef => {
  const retention = projectRetention(value.retention, now);
  return retention === value.retention ? value : { ...value, retention };
};

function projectField<T>(field: DisplayField<T>, now: number): DisplayField<T>;
function projectField<T>(
  field: DisplayField<T> | undefined,
  now: number,
): DisplayField<T> | undefined;
function projectField<T>(field: DisplayField<T> | undefined, now: number) {
  if (field === undefined || field.status !== 'known') return field;
  const evidence = field.evidence.map((item) => projectEvidence(item, now));
  return evidence.every((item, index) => item === field.evidence[index])
    ? field
    : { ...field, evidence };
}

/** Generated text carries one retention, already bounded by what the model was shown. */
const projectText = (value: PublicCard['why'], now: number): PublicCard['why'] => {
  const retention = projectRetention(value.retention, now);
  return retention === value.retention ? value : { ...value, retention };
};

const projectCard = (card: PublicCard, now: number): PublicCard => {
  const facts = { ...card.facts };
  facts.identity = projectField(facts.identity, now);
  if (facts.opening_hours !== undefined) {
    facts.opening_hours = projectField(facts.opening_hours, now);
  }
  if (facts.price !== undefined) {
    facts.price = projectField(facts.price, now);
  }
  if (facts.photos !== undefined) {
    facts.photos = projectField(facts.photos, now);
  }
  if (facts.contact !== undefined) {
    facts.contact = projectField(facts.contact, now);
  }
  if (facts.facilities !== undefined) {
    facts.facilities = projectField(facts.facilities, now);
  }

  return {
    ...card,
    facts,
    why: projectText(card.why, now),
    ...(card.diff === undefined ? {} : { diff: projectText(card.diff, now) }),
  };
};

const projectCards = (cards: CardsData, now: number): CardsData => ({
  hero: projectCard(cards.hero, now),
  alts: cards.alts.map((card) => projectCard(card, now)),
});

const retentionDeadlines = (retention: RetentionMetadata): readonly (string | null)[] => [
  retention.displayUntil,
  retention.sessionExpiresAt,
  retention.retentionUntil,
  retention.deletionScheduledAt,
];

const cardRetentions = (card: PublicCard): readonly RetentionMetadata[] => [
  card.why.retention,
  ...(card.diff === undefined ? [] : [card.diff.retention]),
  ...[
    card.facts.identity,
    card.facts.opening_hours,
    card.facts.price,
    card.facts.photos,
    card.facts.contact,
    card.facts.facilities,
  ].flatMap((field) =>
    field?.status === 'known' ? field.evidence.map((item) => item.retention) : [],
  ),
];

const stateRetentions = (state: AssistantResponseState): readonly RetentionMetadata[] => [
  ...state.responseRecords.flatMap((record) => record.messages.map((message) => message.retention)),
  ...(state.cards === null
    ? []
    : [state.cards.hero, ...state.cards.alts].flatMap((card) => cardRetentions(card))),
];

/** Returns the next raw retention boundary that can change the render projection. */
export const nextAssistantResponseExpiryAt = (
  state: AssistantResponseState,
  now: AssistantResponseProjectionNow,
): string | null => {
  const nowMilliseconds = parseNow(now);
  let next: { readonly value: string; readonly milliseconds: number } | null = null;
  for (const retention of stateRetentions(state)) {
    for (const deadline of retentionDeadlines(retention)) {
      if (deadline === null) continue;
      const milliseconds = Date.parse(deadline);
      if (milliseconds <= nowMilliseconds) continue;
      if (next === null || milliseconds < next.milliseconds) {
        next = { value: deadline, milliseconds };
      }
    }
  }
  return next?.value ?? null;
};

/**
 * Derive the renderable response from raw state without changing the retained payload.
 * `displayUntil` is inclusive of the deny boundary: equality is already expired.
 */
export const projectAssistantResponseState = (
  state: AssistantResponseState,
  now: AssistantResponseProjectionNow,
): AssistantResponseState => {
  const milliseconds = parseNow(now);
  return {
    ...state,
    responseRecords: state.responseRecords.map((record) => ({
      ...record,
      messages: record.messages.map((message) => projectText(message, milliseconds)),
    })),
    cards: state.cards === null ? null : projectCards(state.cards, milliseconds),
  };
};
