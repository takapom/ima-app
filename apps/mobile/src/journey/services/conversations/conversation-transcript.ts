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
    : live.map(({ message }) => ({
        kind: 'retained_text',
        text: message.text,
        retention: message.retention,
      }));
};
