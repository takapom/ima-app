import type { ConversationCards } from '@worker/domain/conversations/conversation-cards';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
type Card = ConversationCards['cards']['hero'];

const deadline = (policy: RetentionMetadata): number =>
  Math.min(
    ...[
      policy.sessionExpiresAt,
      policy.displayUntil,
      policy.retentionUntil,
      policy.deletionScheduledAt,
    ]
      .filter((value) => value !== null)
      .map(Date.parse),
  );
const unavailable = (
  policy: RetentionMetadata,
  now: string,
): 'expired' | 'policy_withheld' | null => {
  if (
    policy.policyStatus === 'expired' ||
    policy.displayPolicyStatus === 'expired' ||
    Date.parse(now) >= deadline(policy)
  )
    return 'expired';
  return policy.retentionDecision === 'allow' &&
    policy.restoreMode === 'full' &&
    policy.policyStatus === 'available' &&
    policy.displayPolicyStatus === 'available' &&
    policy.retentionUntil !== null &&
    policy.deletionScheduledAt !== null
    ? null
    : 'policy_withheld';
};
const reason = (value: 'expired' | 'policy_withheld') =>
  value === 'expired' ? '保存期限が過ぎています' : '保存が許可されていません';
const retainField = <T extends NonNullable<Card['facts'][keyof Card['facts']]>>(
  field: T,
  now: string,
) => {
  if (field?.status !== 'known') return field;
  const failure = field.evidence
    .map((entry) => unavailable(entry.retention, now))
    .find((value) => value !== null);
  return failure === undefined ? field : { status: 'unknown' as const, reason: reason(failure) };
};
const retainText = (text: Card['why'], now: string): Card['why'] => {
  const failure = unavailable(text.retention, now);
  return failure === null
    ? text
    : {
        text: reason(failure),
        retention: { ...text.retention, attribution: null, displayPolicyStatus: failure },
      };
};
export const retainConversationCards = (
  part: ConversationCards,
  now: string,
): ConversationCards => {
  const keepPhotos =
    part.photosExpireAt !== null && Date.parse(now) < Date.parse(part.photosExpireAt);
  const retainCard = (card: Card): Card => {
    const retained = structuredClone(card);
    // Assign individually to preserve each fact's value type without weakening the contract.
    retained.facts.identity = retainField(card.facts.identity, now);
    if (card.facts.opening_hours !== undefined)
      retained.facts.opening_hours = retainField(card.facts.opening_hours, now);
    if (card.facts.price !== undefined) retained.facts.price = retainField(card.facts.price, now);
    if (card.facts.contact !== undefined)
      retained.facts.contact = retainField(card.facts.contact, now);
    if (card.facts.facilities !== undefined)
      retained.facts.facilities = retainField(card.facts.facilities, now);
    if (card.facts.photos !== undefined)
      retained.facts.photos = keepPhotos
        ? retainField(card.facts.photos, now)
        : { status: 'unknown', reason: '写真の表示期限が過ぎています' };
    retained.why = retainText(card.why, now);
    if (card.diff !== undefined) retained.diff = retainText(card.diff, now);
    return retained;
  };
  return {
    ...part,
    photosExpireAt: keepPhotos ? part.photosExpireAt : null,
    cards: { hero: retainCard(part.cards.hero), alts: part.cards.alts.map(retainCard) },
  };
};
export const conversationCardsDeadlines = (part: ConversationCards): number[] => {
  const values: number[] = [];
  for (const card of [part.cards.hero, ...part.cards.alts]) {
    for (const field of Object.values(card.facts))
      if (field?.status === 'known')
        for (const evidence of field.evidence) values.push(deadline(evidence.retention));
    for (const text of [card.why, card.diff])
      if (text?.retention.displayPolicyStatus === 'available')
        values.push(deadline(text.retention));
    if (card.facts.photos?.status === 'known' && part.photosExpireAt !== null)
      values.push(Date.parse(part.photosExpireAt));
  }
  return values;
};
