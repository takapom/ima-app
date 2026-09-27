import type { Conversation, ConversationMessage } from '@ima/contracts';
export type ConversationPage = {
  readonly messages: readonly ConversationMessage[];
  readonly nextBeforeSequence: number | null;
};
export type ConversationCache = {
  list(): readonly Conversation[];
  /** Only server listing order decides eligibility; opening an old conversation never promotes it. */
  setRecent(conversations: readonly Conversation[]): void;
  page(id: string, beforeSequence?: number | null): ConversationPage;
  completeRevision(id: string): number | null;
  markComplete(conversation: Conversation): void;
  write(conversation: Conversation, messages: readonly ConversationMessage[]): void;
  remove(id: string): void;
  /** Removes one expiry batch; true means another batch may remain. */
  cleanup(): boolean;
};
