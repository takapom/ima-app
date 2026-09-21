import type { Conversation, ConversationMessage } from '@ima/contracts';
export type ConversationCache = {
  list(): readonly Conversation[];
  messages(id: string): readonly ConversationMessage[];
  write(conversation: Conversation, messages: readonly ConversationMessage[]): void;
  remove(id: string): void;
  cleanup(): void;
};
