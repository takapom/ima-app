import type { ProviderRecordIdentity } from '@worker/core/domain/candidates/registry';
import type {
  ConversationCards,
  ConversationPhotoSource,
} from '@worker/core/domain/conversations/conversation-cards';
import type { RuntimeCardEvidenceResolver } from '@worker/infrastructure/runtime/response/runtime-response';
import type { ConversationMessage } from '@worker/core/domain/conversations/conversation-message';

type ConversationPhotoSourceCard = {
  readonly candidateId: string;
  readonly evidenceIds: readonly string[];
};

type ConversationPhotoSourceResponse =
  | { readonly presentation: 'keep' }
  | {
      readonly presentation: 'replace';
      readonly hero: ConversationPhotoSourceCard;
      readonly alts: readonly ConversationPhotoSourceCard[];
    };

/** 接続中のProviderが写真再取得に受け付ける店舗識別か。形式の知識は呼び出し側が渡す。 */
export type ConversationPhotoIdentityAcceptance = (identity: ProviderRecordIdentity) => boolean;

const sameIdentity = (left: ProviderRecordIdentity, right: ProviderRecordIdentity): boolean =>
  left.provider === right.provider && left.recordRef === right.recordRef;

/** 生成文やモデルが返したURLから店舗IDを作ると、検証済み根拠以外が参照になる。 */
export const committedConversationPhotoSources = (
  response: ConversationPhotoSourceResponse,
  resolve: RuntimeCardEvidenceResolver | undefined,
  acceptsIdentity: ConversationPhotoIdentityAcceptance,
): ConversationPhotoSource[] => {
  if (response.presentation === 'keep' || resolve === undefined) return [];
  return [response.hero, ...response.alts].flatMap((card) => {
    const identities: ProviderRecordIdentity[] = [];
    for (const evidenceId of card.evidenceIds) {
      const link = resolve(card.candidateId, evidenceId);
      if (
        link?.field !== 'identity' ||
        link.candidateId !== card.candidateId ||
        link.retention.retentionDecision !== 'allow' ||
        link.retention.restoreMode !== 'full'
      )
        continue;
      for (const source of link.sources) {
        const identity = { provider: source.provider, recordRef: source.recordRef };
        if (!acceptsIdentity(identity)) continue;
        if (identities.some((current) => sameIdentity(current, identity))) continue;
        identities.push(identity);
      }
    }
    const identity = identities[0];
    return identities.length === 1 && identity !== undefined
      ? [
          {
            candidateId: card.candidateId,
            provider: identity.provider,
            recordRef: identity.recordRef,
          },
        ]
      : [];
  });
};

/** Only canonical provider links emitted in saved cards can become durable shop references. */
const legacyPhotoSource = (card: ConversationCards['cards']['hero']): ConversationPhotoSource[] => {
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
  try {
    const url = new URL(identity.value.sourceUrl);
    const id = /^\/str(J[0-9]{1,127})\/$/.exec(url.pathname)?.[1];
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.hotpepper.jp' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      id === undefined
    )
      return [];
    return [{ candidateId: card.candidateId, provider: 'hotpepper' as const, recordRef: id }];
  } catch {
    return [];
  }
};

const mayMigrateLegacySourceAt = (
  card: ConversationCards['cards']['hero'],
  now: string,
): boolean => {
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

export const conversationPhotoSources = (
  part: Pick<ConversationCards, 'cards' | 'photoSources'>,
  now?: string,
): ConversationPhotoSource[] =>
  part.photoSources ??
  (now === undefined
    ? []
    : [part.cards.hero, ...part.cards.alts]
        .filter((card) => mayMigrateLegacySourceAt(card, now))
        .flatMap(legacyPhotoSource));

/** Upgrade older snapshots before retention removes their source links. */
export const withConversationPhotoSources = (
  record: ConversationMessage,
  now: string,
): ConversationMessage => ({
  ...record,
  message: {
    ...record.message,
    parts: record.message.parts.map((part) => {
      if (part.kind !== 'card_set') return part;
      const sources = conversationPhotoSources(part, now);
      return sources.length > 0 ? { ...part, photoSources: sources } : part;
    }),
  },
});

/** Refresh lookups stay server-side; clients address photos by conversation/sequence/candidate. */
export const publicConversationMessage = (record: ConversationMessage) => ({
  ...record,
  message: {
    ...record.message,
    parts: record.message.parts.map((part) => {
      if (part.kind !== 'card_set') return part;
      const { photoSources: sources, ...snapshot } = part;
      void sources;
      const ids = conversationPhotoSources(part).map((source) => source.candidateId);
      return ids.length === 0 ? snapshot : { ...snapshot, photoCandidateIds: ids };
    }),
  },
});
