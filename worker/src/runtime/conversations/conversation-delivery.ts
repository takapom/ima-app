import * as v from 'valibot';
import { conversationPhotoSources } from '@worker/runtime/conversations/conversation-photo-sources';
import type { ConversationPhotoSource } from '@worker/domain/conversations/conversation-cards';
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
  sources?: readonly ConversationPhotoSource[],
): ConversationMessageInput => {
  const parsed = v.parse(AssistantResponseSchema, response);
  const photoSources =
    sources ??
    (parsed.kind === 'cards' ? conversationPhotoSources({ cards: parsed.cards }, now) : []);

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
        ? [
            retainConversationPart(
              {
                kind: 'card_set',
                threadId: parsed.threadId,
                cardSetId: parsed.cardSetId,
                revision: parsed.revision,
                cards: parsed.cards,
                ...(sources === undefined && photoSources.length === 0
                  ? {}
                  : { photoSources: [...photoSources] }),
                photosExpireAt: photoDeadline(parsed),
              },
              now,
            ),
          ]
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

/** Tokens remain opaque outside the runtime; only their signed server-issued expiry is projected. */
const photoDeadline = (response: Extract<AssistantResponse, { kind: 'cards' }>): string | null => {
  const tokens = [response.cards.hero, ...response.cards.alts].flatMap((card) =>
    card.facts.photos?.status === 'known'
      ? card.facts.photos.value.photos.map((photo) => photo.photoToken)
      : [],
  );
  if (tokens.length === 0) return null;
  try {
    const times = tokens.map((token) => {
      const payload: unknown = JSON.parse(
        atob((token.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/')),
      );
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('e' in payload) ||
        typeof payload.e !== 'number' ||
        !Number.isSafeInteger(payload.e)
      )
        throw new Error('INVALID_PHOTO_EXPIRY');
      return payload.e * 1000;
    });
    return new Date(Math.min(...times)).toISOString();
  } catch {
    return null;
  }
};
