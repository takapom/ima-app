import type { ConversationMemory } from '@worker/domain/conversations/conversation-memory';
export { ConversationMemorySchema } from '@worker/domain/conversations/conversation-memory';
export type { ConversationMemory } from '@worker/domain/conversations/conversation-memory';

export type ProjectedConversationMemory = Omit<ConversationMemory, 'ownerScopeRef'>;

export const projectConversationMemory = (
  memory: ConversationMemory,
  ownerScopeRef: string,
  now: string,
): ProjectedConversationMemory => {
  if (
    memory.ownerScopeRef !== ownerScopeRef ||
    memory.entries.some((entry) => entry.sequence >= memory.beforeSequence) ||
    (memory.summary !== null &&
      memory.summary !== undefined &&
      (memory.summary.throughSequence >= (memory.entries[0]?.sequence ?? memory.beforeSequence) ||
        memory.summary.excerpts.some(
          (entry) => entry.sequence > (memory.summary?.throughSequence ?? 0),
        )))
  )
    throw new Error('CONVERSATION_MEMORY_SCOPE_MISMATCH');
  return {
    conversationId: memory.conversationId,
    beforeSequence: memory.beforeSequence,
    ...(memory.summary === undefined ? {} : { summary: memory.summary }),
    entries: memory.entries.filter(
      (entry) => entry.expiresAt === null || Date.parse(entry.expiresAt) > Date.parse(now),
    ),
  };
};
