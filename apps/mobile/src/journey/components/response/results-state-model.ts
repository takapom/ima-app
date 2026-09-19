import type { PublicMessage } from '@ima/contracts';
import type {
  AssistantMessageRecord,
  CardSetDisplayState,
} from '@mobile/journey/state/assistant-response';

export type MessageCardSetRelation = 'current' | 'past' | 'none';

export type MessageHistoryItem = {
  readonly key: string;
  readonly responseId: AssistantMessageRecord['responseId'];
  readonly revision: AssistantMessageRecord['revision'];
  readonly cardSetId: AssistantMessageRecord['cardSetId'];
  readonly relation: MessageCardSetRelation;
  readonly message: PublicMessage | null;
  readonly displayPolicyStatus: PublicMessage['retention']['displayPolicyStatus'];
};

export const buildMessageHistory = (
  records: readonly AssistantMessageRecord[],
  currentCardSetId: string | null,
  cardsAvailable: boolean,
): readonly MessageHistoryItem[] =>
  records.map((record, index) => ({
    key: `${record.responseId}:${record.revision}:${index}`,
    responseId: record.responseId,
    revision: record.revision,
    cardSetId: record.cardSetId,
    relation:
      record.cardSetId === null
        ? 'none'
        : cardsAvailable && record.cardSetId === currentCardSetId
          ? 'current'
          : 'past',
    message: record.message.retention.displayPolicyStatus === 'available' ? record.message : null,
    displayPolicyStatus: record.message.retention.displayPolicyStatus,
  }));

export const cardSetStatusLabel = (
  display: CardSetDisplayState,
  hasMessage = false,
): string | null => {
  if (display.kind === 'kept') return '前の候補を表示中';
  if (display.kind !== 'empty') return null;
  if (display.reason === 'no_cards') return hasMessage ? null : '候補はまだ提示されていません。';
  if (display.reason === 'reference_only') return '過去の候補を復元できませんでした。';
  if (display.reason === 'unavailable') return '過去の候補は現在表示できません。';
  return null;
};
