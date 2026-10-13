import type { ConversationMemory } from '@worker/core/domain/conversations/conversation-memory';
import type {
  ConversationScope,
  ConversationStoreFailure,
} from '@worker/core/application/ports/conversation-store';

export type ConversationMemoryStore = {
  loadMemory(
    input: ConversationScope & { readonly beforeSequence: number; readonly now: string },
  ): Promise<{ readonly ok: true; readonly memory: ConversationMemory } | ConversationStoreFailure>;
};
