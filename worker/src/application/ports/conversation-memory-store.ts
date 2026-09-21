import type { ConversationMemory } from '@worker/domain/conversations/conversation-memory';
import type {
  ConversationScope,
  ConversationStoreFailure,
} from '@worker/application/ports/conversation-store';

export type ConversationMemoryStore = {
  loadMemory(
    input: ConversationScope & { readonly beforeSequence: number; readonly now: string },
  ): Promise<{ readonly ok: true; readonly memory: ConversationMemory } | ConversationStoreFailure>;
};
