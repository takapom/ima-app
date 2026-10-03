import type {
  ConversationCards,
  ConversationPhotoSource,
} from '@worker/domain/conversations/conversation-cards';
import type { CommittedResponse } from '@worker/application/use-cases/submit-response/submit-application';
import type { RuntimeCardEvidenceResolver } from '@worker/runtime/response/runtime-response';
import type { ConversationMessage } from '@worker/domain/conversations/conversation-message';

/** New answers use provider record IDs from validated evidence, never a model-supplied ID. */
export const committedConversationPhotoSources = (
  response: CommittedResponse,
  resolve: RuntimeCardEvidenceResolver | undefined,
): ConversationPhotoSource[] => {
  if (response.presentation === 'keep' || resolve === undefined) return [];
  return [response.hero, ...response.alts].flatMap((card) => {
    const links = card.evidenceIds
      .map((id) => resolve(card.candidateId, id))
      .filter(
        (link) =>
          link?.field === 'identity' &&
          link.candidateId === card.candidateId &&
          link.retention.retentionDecision === 'allow' &&
          link.retention.restoreMode === 'full',
      );
    const ids = [
      ...new Set(
        links.flatMap(
          (link) =>
            link?.sources
              .filter(
                (source) =>
                  source.provider === 'hotpepper' && /^J[0-9]{1,127}$/.test(source.recordRef),
              )
              .map((source) => source.recordRef) ?? [],
        ),
      ),
    ];
    return ids.length === 1 && ids[0] !== undefined
      ? [{ candidateId: card.candidateId, provider: 'hotpepper' as const, recordRef: ids[0] }]
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
