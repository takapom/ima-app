import type {
  ThreadSnapshotResult,
  ThreadDeleteResult,
} from '@worker/runtime/threads/thread-types';
import type {
  ThreadRuntimeTurnInput,
  ThreadRuntimeTurnResult,
  ThreadRuntimeCancelResult,
} from '@worker/runtime/threads/admission';
import type {
  ConversationDelivery,
  ConversationDeliveryScope,
} from '@worker/runtime/conversations/conversation-delivery';
export type ConversationThreadNamespace = {
  readonly getByName: (name: string) => {
    initialize(
      owner: string,
      threadId: string,
      requireActiveSession?: boolean,
    ): Promise<ThreadSnapshotResult>;
    read(owner: string): Promise<ThreadSnapshotResult>;
    deleteThread(
      owner: string,
      turnId: string | null,
      revision: number | null,
      idempotencyKey: string,
    ): Promise<ThreadDeleteResult>;
    cancelRuntimeTurn(input: unknown): Promise<ThreadRuntimeCancelResult>;
    runConversationTurn(
      scope: ConversationDeliveryScope,
      input: ThreadRuntimeTurnInput,
    ): Promise<ThreadRuntimeTurnResult>;
    readConversationDelivery(
      scope: ConversationDeliveryScope,
    ): Promise<ConversationDelivery | null>;
    acknowledgeConversationDelivery(scope: ConversationDeliveryScope): Promise<void>;
  };
};
