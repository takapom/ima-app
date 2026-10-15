import type {
  ConversationCards,
  ConversationPhotoSource,
} from '@worker/core/domain/conversations/conversation-cards';
import type { ConversationMessage } from '@worker/core/domain/conversations/conversation-message';
import { parseHotPepperPhotoIdentity } from '@worker/infrastructure/adapters/out/providers/hot-pepper/conversation-photo-reference';

type LegacyCard = ConversationCards['cards']['hero'];

const legacyPhotoSource = (card: LegacyCard): ConversationPhotoSource[] => {
  const identity = card.facts.identity;
  if (identity.status !== 'known' || identity.value.sourceUrl === null) return [];
  if (
    identity.evidence.some(
      ({ retention }) =>
        retention.retentionDecision !== 'allow' ||
        retention.restoreMode !== 'full' ||
        retention.policyStatus !== 'available',
    )
  )
    return [];
  const parsed = parseHotPepperPhotoIdentity(identity.value.sourceUrl);
  if (parsed === undefined) return [];
  return [
    {
      candidateId: card.candidateId,
      provider: parsed.provider,
      recordRef: parsed.recordRef,
    },
  ];
};

/** 期限ちょうどを未来に含めると、読み出すたびに参照の寿命が伸びる。 */
const mayCompleteLegacySourceAt = (card: LegacyCard, now: string): boolean => {
  const current = Date.parse(now);
  const identity = card.facts.identity;
  if (identity.status !== 'known') return false;
  return identity.evidence.every(({ retention }) => {
    const deadlines = [
      retention.sessionExpiresAt,
      retention.displayUntil,
      retention.retentionUntil,
      retention.deletionScheduledAt,
    ].filter((value): value is string => value !== null);
    return (
      retention.retentionDecision === 'allow' &&
      retention.restoreMode === 'full' &&
      retention.policyStatus === 'available' &&
      retention.displayPolicyStatus === 'available' &&
      retention.retentionUntil !== null &&
      retention.deletionScheduledAt !== null &&
      deadlines.every((deadline) => current < Date.parse(deadline))
    );
  });
};

/** 保存済み参照を掲載URLで上書きすると、検証済みの店舗識別がリンクの解釈に置き換わる。 */
export const withLegacyConversationPhotoSources = (
  record: ConversationMessage,
  now: string,
): ConversationMessage => ({
  ...record,
  message: {
    ...record.message,
    parts: record.message.parts.map((part) => {
      if (part.kind !== 'card_set' || part.photoSources !== undefined) return part;
      const sources = [part.cards.hero, ...part.cards.alts]
        .filter((card) => mayCompleteLegacySourceAt(card, now))
        .flatMap(legacyPhotoSource);
      return sources.length > 0 ? { ...part, photoSources: sources } : part;
    }),
  },
});
