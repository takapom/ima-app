import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/domain/primitives';
import { RetentionMetadataSchema } from '@worker/domain/evidence/retention';

import { ConversationCardsSchema } from '@worker/domain/conversations/conversation-cards';
import { retainConversationCards } from '@worker/domain/conversations/conversation-card-retention';

/** User-authored text has its own lifetime; an assistant cannot grant itself this policy. */
const UserTextSchema = v.strictObject({
  kind: v.literal('user_text'),
  text: v.pipe(
    Text(500),
    v.check((value) => value.trim().length > 0, 'user text is blank'),
  ),
});
const RetainedTextSchema = v.strictObject({
  kind: v.literal('retained_text'),
  text: Text(500),
  retention: RetentionMetadataSchema,
});
const UnavailablePartSchema = v.strictObject({
  kind: v.literal('unavailable'),
  reason: v.picklist(['expired', 'policy_withheld']),
});
const CardSetReferenceSchema = v.strictObject({
  kind: v.literal('card_set_reference'),
  threadId: OpaqueIdSchema,
  cardSetId: OpaqueIdSchema,
});

export const ConversationPartSchema = v.variant('kind', [
  UserTextSchema,
  RetainedTextSchema,
  UnavailablePartSchema,
  CardSetReferenceSchema,
  ConversationCardsSchema,
]);
export type ConversationPart = v.InferOutput<typeof ConversationPartSchema>;

export const ConversationMessageInputSchema = v.pipe(
  v.strictObject({
    messageId: OpaqueIdSchema,
    role: v.picklist(['user', 'assistant']),
    source: v.nullable(
      v.strictObject({
        threadId: OpaqueIdSchema,
        turnId: OpaqueIdSchema,
        responseId: v.nullable(OpaqueIdSchema),
      }),
    ),
    parts: v.pipe(v.array(ConversationPartSchema), v.minLength(1), v.maxLength(16)),
  }),
  v.check((message) => {
    if (message.role === 'user') {
      return (
        (message.source === null || message.source.responseId === null) &&
        message.parts.length === 1 &&
        message.parts.every((part) => part.kind === 'user_text' || part.kind === 'unavailable')
      );
    }
    return (
      message.source !== null &&
      message.source.responseId !== null &&
      message.parts.every(
        (part) =>
          part.kind !== 'user_text' &&
          ((part.kind !== 'card_set_reference' && part.kind !== 'card_set') ||
            part.threadId === message.source?.threadId),
      )
    );
  }, 'message role, source and parts are inconsistent'),
);
export type ConversationMessageInput = Readonly<
  v.InferOutput<typeof ConversationMessageInputSchema>
>;

export const ConversationMessageSchema = v.strictObject({
  conversationId: OpaqueIdSchema,
  sequence: RevisionSchema,
  createdAt: IsoTimestampSchema,
  message: ConversationMessageInputSchema,
});
export type ConversationMessage = Readonly<v.InferOutput<typeof ConversationMessageSchema>>;

/** Apply before every storage write and read. Freshness is separate from quoting past speech. */
export const retainConversationPart = (part: ConversationPart, now: string): ConversationPart => {
  const parsed = v.safeParse(ConversationPartSchema, part);
  const clock = v.safeParse(IsoTimestampSchema, now);
  if (!parsed.success || !clock.success) throw new Error('INVALID_CONVERSATION_RETENTION_INPUT');
  if (parsed.output.kind === 'card_set') return retainConversationCards(parsed.output, now);
  if (parsed.output.kind !== 'retained_text') return structuredClone(parsed.output);
  const { retention } = parsed.output;
  if (retention.policyStatus === 'expired' || retention.displayPolicyStatus === 'expired') {
    return { kind: 'unavailable', reason: 'expired' };
  }
  if (
    retention.retentionDecision !== 'allow' ||
    retention.restoreMode !== 'full' ||
    retention.policyStatus !== 'available' ||
    retention.displayPolicyStatus !== 'available' ||
    retention.retentionUntil === null ||
    retention.deletionScheduledAt === null
  ) {
    return { kind: 'unavailable', reason: 'policy_withheld' };
  }
  const deadlines = [
    retention.sessionExpiresAt,
    retention.displayUntil,
    retention.retentionUntil,
    retention.deletionScheduledAt,
  ].filter((value) => value !== null);
  return deadlines.some((deadline) => Date.parse(now) >= Date.parse(deadline))
    ? { kind: 'unavailable', reason: 'expired' }
    : structuredClone(parsed.output);
};

export const retainConversationMessage = (
  message: ConversationMessage,
  now: string,
): ConversationMessage => ({
  ...structuredClone(message),
  message: {
    ...structuredClone(message.message),
    parts: message.message.parts.map((part) => retainConversationPart(part, now)),
  },
});
