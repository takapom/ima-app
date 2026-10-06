import type { ConversationMessage } from '@ima/contracts';
import type { AssistantMessageRecord } from '@mobile/journey/state/assistant-response';

/** Display projection only. Live text must never be written back to the conversation cache. */
export const conversationTranscriptParts = (
  record: ConversationMessage,
  liveMessages: readonly AssistantMessageRecord[],
): ConversationMessage['message']['parts'] => {
  if (record.message.role !== 'assistant') return record.message.parts;
  const live = liveMessages.filter(
    (item) =>
      item.responseId === record.message.source?.responseId &&
      item.message.retention.displayPolicyStatus === 'available',
  );
  return live.length === 0
    ? record.message.parts
    : [
        ...live.map(({ message }) => ({
          kind: 'retained_text' as const,
          text: message.text,
          retention: message.retention,
        })),
        ...record.message.parts.filter(
          (part) => part.kind === 'card_set' || part.kind === 'card_set_reference',
        ),
      ];
};

/** Unsynced live text is a display row only; it never enters the persisted message collection. */
export const conversationTranscriptEntries = (
  records: readonly ConversationMessage[],
  liveMessages: readonly AssistantMessageRecord[],
  unsyncedTurnId: string | null,
): readonly Pick<ConversationMessage['message'], 'messageId' | 'role' | 'parts'>[] => {
  const entries = records.map((record) => ({
    messageId: record.message.messageId,
    role: record.message.role,
    parts: conversationTranscriptParts(record, liveMessages),
  }));
  const missing = liveMessages.filter(
    (item) =>
      item.turnId === unsyncedTurnId &&
      item.message.retention.displayPolicyStatus === 'available' &&
      !records.some((record) => record.message.source?.responseId === item.responseId),
  );
  if (missing.length > 0)
    entries.push({
      messageId: `live-${unsyncedTurnId}`,
      role: 'assistant',
      parts: missing.map(({ message }) => ({
        kind: 'retained_text',
        text: message.text,
        retention: message.retention,
      })),
    });
  return entries;
};

/** An answer that came with cards keeps its explanation folded; the cards and the dog lead. */
export const foldsExplanation = (
  entry: Pick<ConversationMessage['message'], 'role' | 'parts'>,
): boolean =>
  entry.role === 'assistant' &&
  entry.parts.some((part) => part.kind === 'card_set') &&
  entry.parts.some((part) => part.kind === 'retained_text');
