import * as v from 'valibot';
import { AssistantResponseSchema, type AssistantResponse } from '@ima/contracts';
import {
  ConversationMessageInputSchema,
  retainConversationPart,
  type ConversationMessageInput,
} from '@worker/domain/conversations/conversation-message';
import type { ThreadRuntimeTarget } from '@worker/runtime/threads/admission';
import { OpaqueIdSchema } from '@worker/domain/primitives';

export const ConversationDeliveryScopeSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  conversationId: OpaqueIdSchema,
  runId: OpaqueIdSchema,
});
export type ConversationDeliveryScope = v.InferOutput<typeof ConversationDeliveryScopeSchema>;
export const messageFromConversationResponse = (
  response: unknown,
  messageId: string,
  now: string,
): ConversationMessageInput => {
  const parsed = v.parse(AssistantResponseSchema, response);
  return v.parse(ConversationMessageInputSchema, {
    messageId,
    role: 'assistant',
    source: { threadId: parsed.threadId, turnId: parsed.turnId, responseId: parsed.responseId },
    parts: [
      ...parsed.message.map((part) =>
        retainConversationPart(
          { kind: 'retained_text', text: part.text, retention: part.retention },
          now,
        ),
      ),
      ...(parsed.kind === 'cards'
        ? [{ kind: 'card_set_reference', threadId: parsed.threadId, cardSetId: parsed.cardSetId }]
        : []),
    ],
  });
};
export type ConversationDelivery = ConversationDeliveryScope & {
  readonly message: ConversationMessageInput;
  readonly inputFingerprint: string;
  /** Ephemeral validated transport payload. Absent after host eviction or display expiry. */
  readonly response?: AssistantResponse;
};
export type BoundConversationTurn = ConversationDeliveryScope & {
  readonly target: ThreadRuntimeTarget;
};
