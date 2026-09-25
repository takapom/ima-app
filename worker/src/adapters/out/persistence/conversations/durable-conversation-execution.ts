import * as v from 'valibot';
import {
  AssistantResponseSchema,
  ConversationTurnRequestSchema,
  type AssistantResponse,
  type ConversationTurnRequest,
  type ThreadTurnRequest,
} from '@ima/contracts';
import type { ConversationRunScope } from '@worker/application/ports/conversation-runs';
import type { ConversationThreadPort } from '@worker/application/ports/conversation-execution';
import type { ConversationThreadNamespace } from '@worker/runtime/ports/conversation-thread';
import type { PreparedConversationExecution } from '@worker/runtime/conversations/conversation-execution';
import type { ThreadRuntimeFailureCode } from '@worker/runtime/threads/admission';
export type ConversationExecutionObserver = {
  readonly onResponse: (scope: ConversationRunScope, response: AssistantResponse) => void;
  readonly onFailure?: (code: ThreadRuntimeFailureCode) => void;
};
export const createConversationThreadPort = (
  threads: ConversationThreadNamespace,
  observer: ConversationExecutionObserver,
): ConversationThreadPort => ({
  async initialize(ownerScopeRef, threadId) {
    const result = await threads.getByName(threadId).initialize(ownerScopeRef, threadId, true);
    return result.ok
      ? { active: result.snapshot.active, revision: result.snapshot.revision }
      : undefined;
  },
  async readDelivery(scope) {
    const { threadId, ...deliveryScope } = scope;
    const delivery = await threads.getByName(threadId).readConversationDelivery(deliveryScope);
    if (delivery === null) return null;
    if (delivery.response !== undefined) observer.onResponse(scope, delivery.response);
    return { message: delivery.message, inputFingerprint: delivery.inputFingerprint };
  },
  acknowledgeDelivery: ({ threadId, ...scope }) =>
    threads.getByName(threadId).acknowledgeConversationDelivery(scope),
  async cancel(target) {
    await threads.getByName(target.threadId).cancelRuntimeTurn({
      ownerScopeRef: target.ownerScopeRef,
      threadId: target.threadId,
      turnId: target.turnId,
      revision: target.revision,
    });
  },
});
const TurnFieldsSchema = v.object(
  v.omit(ConversationTurnRequestSchema, ['expectedRevision', 'clientMessageId']).entries,
);

export const prepareConversationExecution = (
  threads: ConversationThreadNamespace,
  observer: ConversationExecutionObserver,
  scope: ConversationRunScope,
  request: ConversationTurnRequest,
  deviceId: string,
): PreparedConversationExecution => {
  let response: unknown;
  return {
    async run({ target, memory, resetCandidates }) {
      const turnFields = v.parse(TurnFieldsSchema, request);
      const turnRequest: ThreadTurnRequest = {
        ...turnFields,
        revision: target.revision,
        turnId: target.turnId,
        ...(resetCandidates
          ? {
              cardSetId: null,
              promotedCandidateId: null,
              selectedCandidateId: null,
              candidateOrder: [],
              excludeCandidateIds: [],
            }
          : {}),
      };
      const result = await threads.getByName(target.threadId).runConversationTurn(scope, {
        ownerScopeRef: scope.ownerScopeRef,
        threadId: target.threadId,
        turnId: target.turnId,
        revision: target.revision,
        idempotencyKey: request.idempotencyKey,
        deviceId,
        input: turnRequest,
        conversationMemory: memory,
      });
      if (result.status !== 'completed') observer.onFailure?.(result.code ?? 'RUNTIME_FAILED');
      response = result.response;
      return { completed: result.status === 'completed' };
    },
    publish() {
      const parsed = v.safeParse(AssistantResponseSchema, response);
      if (parsed.success) observer.onResponse(scope, parsed.output);
    },
  };
};
