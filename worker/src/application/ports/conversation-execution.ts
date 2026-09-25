import type { ConversationRunScope } from '@worker/application/ports/conversation-runs';
import type { ConversationMemory } from '@worker/domain/conversations/conversation-memory';
import type { ConversationMessageInput } from '@worker/domain/conversations/conversation-message';
export type ConversationThreadScope = ConversationRunScope & { readonly threadId: string };
export type ConversationExecutionTarget = ConversationThreadScope & {
  readonly turnId: string;
  readonly revision: number;
};
/** Platform-neutral operations needed to reconcile one durable run. */
export type ConversationThreadPort = {
  initialize(
    ownerScopeRef: string,
    threadId: string,
  ): Promise<{ readonly active: boolean; readonly revision: number } | undefined>;
  readDelivery(scope: ConversationThreadScope): Promise<{
    readonly message: ConversationMessageInput;
    readonly inputFingerprint: string;
  } | null>;
  acknowledgeDelivery(scope: ConversationThreadScope): Promise<void>;
  cancel(target: ConversationExecutionTarget): Promise<void>;
};
/** The adapter binds the already validated transport input; Core supplies execution decisions. */
export type ConversationTurnExecutor = (input: {
  readonly target: ConversationExecutionTarget;
  readonly memory: ConversationMemory;
  readonly resetCandidates: boolean;
}) => Promise<{ readonly completed: boolean }>;
