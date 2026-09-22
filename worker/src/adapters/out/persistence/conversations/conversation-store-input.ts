import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema, RevisionSchema } from '@worker/domain/primitives';
import { ConversationCursorSchema } from '@worker/domain/conversations/conversation';
import { ConversationMessageInputSchema } from '@worker/domain/conversations/conversation-message';

export const ConversationScopeSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  conversationId: OpaqueIdSchema,
});
const PageLimitSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100));

export const CreateConversationInputSchema = v.strictObject({
  ...ConversationScopeSchema.entries,
  now: IsoTimestampSchema,
  idempotencyKey: OpaqueIdSchema,
});

export const AppendConversationMessageInputSchema = v.strictObject({
  ...ConversationScopeSchema.entries,
  now: IsoTimestampSchema,
  expectedRevision: RevisionSchema,
  idempotencyKey: OpaqueIdSchema,
  inputFingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  message: ConversationMessageInputSchema,
});

export const ListConversationsInputSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  limit: PageLimitSchema,
  before: v.nullable(ConversationCursorSchema),
});

export const ReadConversationMessagesInputSchema = v.strictObject({
  ...ConversationScopeSchema.entries,
  now: IsoTimestampSchema,
  limit: PageLimitSchema,
  beforeSequence: v.nullable(RevisionSchema),
});
