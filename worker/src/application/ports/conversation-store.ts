import type { Conversation, ConversationCursor } from '@worker/domain/conversations/conversation';
import type {
  ConversationMessage,
  ConversationMessageInput,
} from '@worker/domain/conversations/conversation-message';

export type ConversationStoreFailure = {
  readonly ok: false;
  readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'REVISION_CONFLICT' | 'IDEMPOTENCY_CONFLICT';
};

export type ConversationScope = {
  readonly ownerScopeRef: string;
  readonly conversationId: string;
};
export type CreateConversationInput = ConversationScope & {
  readonly now: string;
  /** Stable server-generated ID and key must be reused when retrying creation. */
  readonly idempotencyKey: string;
};
export type AppendConversationMessageInput = ConversationScope & {
  readonly now: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  /** SHA-256 of canonical original input, computed before retention removes any body. */
  readonly inputFingerprint: string;
  readonly message: ConversationMessageInput;
};
export type ListConversationsInput = {
  readonly ownerScopeRef: string;
  readonly limit: number;
  readonly before: ConversationCursor | null;
};
export type ReadConversationMessagesInput = ConversationScope & {
  readonly now: string;
  readonly limit: number;
  readonly beforeSequence: number | null;
};

/** Application-owned contract. HTTP DTOs, clocks, SDKs and SQL remain outside this port. */
export type ConversationStore = {
  readonly create: (
    input: CreateConversationInput,
  ) => Promise<
    | { readonly ok: true; readonly conversation: Conversation; readonly replayed: boolean }
    | ConversationStoreFailure
  >;
  readonly read: (
    scope: ConversationScope,
  ) => Promise<
    { readonly ok: true; readonly conversation: Conversation } | ConversationStoreFailure
  >;
  readonly list: (input: ListConversationsInput) => Promise<
    | {
        readonly ok: true;
        readonly conversations: readonly Conversation[];
        readonly nextCursor: ConversationCursor | null;
      }
    | ConversationStoreFailure
  >;
  readonly append: (input: AppendConversationMessageInput) => Promise<
    | {
        readonly ok: true;
        readonly conversation: Conversation;
        readonly message: ConversationMessage;
        readonly replayed: boolean;
      }
    | ConversationStoreFailure
  >;
  readonly messages: (input: ReadConversationMessagesInput) => Promise<
    | {
        readonly ok: true;
        readonly messages: readonly ConversationMessage[];
        readonly nextBeforeSequence: number | null;
      }
    | ConversationStoreFailure
  >;
  /** Repeated deletion succeeds; a deleted ID must never be recreated by a late write. */
  readonly remove: (
    scope: ConversationScope,
  ) => Promise<{ readonly ok: true; readonly deleted: boolean } | ConversationStoreFailure>;
};
