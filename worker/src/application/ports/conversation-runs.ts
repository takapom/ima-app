import type { Conversation } from '@worker/domain/conversations/conversation';
import type { ConversationRun } from '@worker/domain/conversations/conversation-run';
import type { ConversationMessageInput } from '@worker/domain/conversations/conversation-message';
import type {
  ConversationScope,
  ConversationStoreFailure,
} from '@worker/application/ports/conversation-store';

export type AcceptConversationRun = ConversationScope & {
  readonly runId: string;
  readonly messageId: string;
  readonly text: string;
  readonly now: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
};
export type ConversationRunScope = ConversationScope & { readonly runId: string };
export type ConversationRunResult =
  | {
      readonly ok: true;
      readonly run: ConversationRun;
      readonly conversation: Conversation;
      readonly replayed: boolean;
    }
  | ConversationStoreFailure;
export type ConversationRuns = {
  readonly accept: (input: AcceptConversationRun) => Promise<ConversationRunResult>;
  readonly readRun: (scope: ConversationRunScope) => Promise<ConversationRunResult>;
  readonly activeRun: (scope: ConversationScope) => Promise<ConversationRun | null>;
  readonly start: (
    input: ConversationRunScope & {
      readonly now: string;
      readonly threadId: string;
      readonly turnId: string;
    },
  ) => Promise<ConversationRunResult>;
  readonly complete: (
    input: ConversationRunScope & {
      readonly now: string;
      readonly message: ConversationMessageInput;
      readonly inputFingerprint: string;
    },
  ) => Promise<ConversationRunResult>;
  readonly fail: (
    input: ConversationRunScope & { readonly now: string; readonly interrupted: boolean },
  ) => Promise<ConversationRunResult>;
};
