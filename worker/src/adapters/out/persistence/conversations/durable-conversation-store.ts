import type { AssistantResponse, ConversationTurnRequest } from '@ima/contracts';
import type {
  ConversationRunScope,
  ConversationRunResult,
} from '@worker/application/ports/conversation-runs';
import type { ConversationStore } from '@worker/application/ports/conversation-store';
import type { ConversationRuns } from '@worker/application/ports/conversation-runs';

export type ConversationHistoryRpc = ConversationStore & ConversationRuns;
export type ConversationApiRpc = ConversationHistoryRpc & {
  cancelRun(scope: ConversationRunScope): Promise<ConversationRunResult>;
  submit(input: {
    ownerScopeRef: string;
    conversationId: string;
    deviceId: string;
    request: ConversationTurnRequest;
  }): Promise<ConversationRunResult>;
  getRun(
    scope: ConversationRunScope,
  ): Promise<ConversationRunResult & { response?: AssistantResponse | null }>;
};
export type ConversationHistoryNamespace = {
  readonly getByName: (name: string) => ConversationApiRpc;
};
export const conversationOwnerName = (owner: string): string => `conversation-owner:${owner}`;

export const createDurableConversationStore = (
  namespace: ConversationHistoryNamespace,
): ConversationHistoryRpc => {
  const stub = (owner: string) => namespace.getByName(conversationOwnerName(owner));
  return {
    create: (input) => stub(input.ownerScopeRef).create(input),
    read: (input) => stub(input.ownerScopeRef).read(input),
    list: (input) => stub(input.ownerScopeRef).list(input),
    append: (input) => stub(input.ownerScopeRef).append(input),
    messages: (input) => stub(input.ownerScopeRef).messages(input),
    remove: (input) => stub(input.ownerScopeRef).remove(input),
    accept: (input) => stub(input.ownerScopeRef).accept(input),
    readRun: (input) => stub(input.ownerScopeRef).readRun(input),
    activeRun: (input) => stub(input.ownerScopeRef).activeRun(input),
    start: (input) => stub(input.ownerScopeRef).start(input),
    complete: (input) => stub(input.ownerScopeRef).complete(input),
    fail: (input) => stub(input.ownerScopeRef).fail(input),
  };
};
