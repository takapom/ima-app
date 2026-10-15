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

/** 保存済み参照だけを返す。掲載URLからの補完は永続化の読み出しが行う。 */
export const conversationPhotoSources = (
  part: Pick<ConversationCards, 'photoSources'>,
): readonly ConversationPhotoSource[] => part.photoSources ?? [];

/** 再取得の候補IDだけを公開する。内部の店舗参照は履歴の応答に載せない。 */
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
