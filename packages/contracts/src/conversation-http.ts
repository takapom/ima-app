import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
  RequestIdSchema,
  Text,
} from '@contracts/common';
import { RetentionMetadataSchema } from '@contracts/public';
import { ThreadTurnRequestSchema, CreateThreadRequestSchema } from '@contracts/preferences';
import { CardsDataSchema } from '@contracts/values';
import { AssistantResponseSchema } from '@contracts/response';

export const ConversationSchema = v.strictObject({
  conversationId: OpaqueIdSchema,
  title: Text(80),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  revision: RevisionSchema,
  lastSequence: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export type Conversation = v.InferOutput<typeof ConversationSchema>;
export const ConversationCardsSchema = v.strictObject({
  kind: v.literal('card_set'),
  threadId: OpaqueIdSchema,
  cardSetId: OpaqueIdSchema,
  revision: RevisionSchema,
  photosExpireAt: v.nullable(IsoTimestampSchema),
  cards: CardsDataSchema,
});
export type ConversationCards = v.InferOutput<typeof ConversationCardsSchema>;
export const ConversationMessageSchema = v.pipe(
  v.strictObject({
    conversationId: OpaqueIdSchema,
    sequence: RevisionSchema,
    createdAt: IsoTimestampSchema,
    message: v.strictObject({
      messageId: OpaqueIdSchema,
      role: v.picklist(['user', 'assistant']),
      source: v.nullable(
        v.strictObject({
          threadId: OpaqueIdSchema,
          turnId: OpaqueIdSchema,
          responseId: v.nullable(OpaqueIdSchema),
        }),
      ),
      parts: v.pipe(
        v.array(
          v.variant('kind', [
            ConversationCardsSchema,
            v.strictObject({ kind: v.literal('user_text'), text: Text(500) }),
            v.strictObject({
              kind: v.literal('retained_text'),
              text: Text(500),
              retention: RetentionMetadataSchema,
            }),
            v.strictObject({
              kind: v.literal('unavailable'),
              reason: v.picklist(['expired', 'policy_withheld']),
            }),
            v.strictObject({
              kind: v.literal('card_set_reference'),
              threadId: OpaqueIdSchema,
              cardSetId: OpaqueIdSchema,
            }),
          ]),
        ),
        v.minLength(1),
        v.maxLength(16),
      ),
    }),
  }),
  v.check(
    ({ message }) =>
      message.role === 'user'
        ? (message.source === null || message.source.responseId === null) &&
          message.parts.length === 1 &&
          message.parts.every(
            (part) =>
              part.kind === 'unavailable' ||
              (part.kind === 'user_text' && part.text.trim().length > 0),
          )
        : message.source !== null &&
          message.source.responseId !== null &&
          message.parts.every(
            (part) =>
              part.kind !== 'user_text' &&
              ((part.kind !== 'card_set_reference' && part.kind !== 'card_set') ||
                part.threadId === message.source?.threadId),
          ),
    'Message role and retention are inconsistent',
  ),
);

export type ConversationMessage = v.InferOutput<typeof ConversationMessageSchema>;
export const ConversationRunSchema = v.pipe(
  v.strictObject({
    runId: OpaqueIdSchema,
    conversationId: OpaqueIdSchema,
    userMessageId: OpaqueIdSchema,
    inputSequence: RevisionSchema,
    status: v.picklist(['accepted', 'running', 'completed', 'failed', 'interrupted']),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    threadId: v.nullable(OpaqueIdSchema),
    turnId: v.nullable(OpaqueIdSchema),
    assistantMessageId: v.nullable(OpaqueIdSchema),
    failure: v.nullable(v.picklist(['GENERATION_FAILED', 'INTERRUPTED'])),
  }),
  v.check(
    (run) =>
      Date.parse(run.updatedAt) >= Date.parse(run.createdAt) &&
      (run.threadId === null) === (run.turnId === null) &&
      (run.status !== 'accepted' || run.threadId === null) &&
      ((run.status !== 'running' && run.status !== 'completed') || run.threadId !== null) &&
      (run.status === 'completed') === (run.assistantMessageId !== null) &&
      (run.status === 'failed'
        ? run.failure === 'GENERATION_FAILED'
        : run.status === 'interrupted'
          ? run.failure === 'INTERRUPTED'
          : run.failure === null),
    'Run state is inconsistent',
  ),
);

export type ConversationRun = v.InferOutput<typeof ConversationRunSchema>;
const envelope = { schemaVersion: SchemaVersionSchema, requestId: RequestIdSchema };
export const CreateConversationRequestSchema = CreateThreadRequestSchema;
export const ConversationTurnRequestSchema = v.strictObject({
  ...v.omit(ThreadTurnRequestSchema, ['turnId', 'revision']).entries,
  expectedRevision: RevisionSchema,
  clientMessageId: OpaqueIdSchema,
});
export type ConversationTurnRequest = v.InferOutput<typeof ConversationTurnRequestSchema>;
export const ConversationResponseSchema = v.strictObject({
  ...envelope,
  conversation: ConversationSchema,
  activeRun: v.nullable(ConversationRunSchema),
});
export const ConversationListResponseSchema = v.strictObject({
  ...envelope,
  conversations: v.array(ConversationSchema),
  nextCursor: v.nullable(Text(512)),
});
export const ConversationMessagesResponseSchema = v.strictObject({
  ...envelope,
  messages: v.array(ConversationMessageSchema),
  nextBeforeSequence: v.nullable(RevisionSchema),
});
export const ConversationRunResponseSchema = v.pipe(
  v.strictObject({
    ...envelope,
    conversation: ConversationSchema,
    run: ConversationRunSchema,
    response: v.nullable(AssistantResponseSchema),
  }),
  v.check(
    (value) =>
      value.conversation.conversationId === value.run.conversationId &&
      (value.response === null ||
        (value.run.status === 'completed' &&
          value.response.threadId === value.run.threadId &&
          value.response.turnId === value.run.turnId)),
    'Run response scope is inconsistent',
  ),
);

export type ConversationRunResponse = v.InferOutput<typeof ConversationRunResponseSchema>;

export type ConversationResponse = v.InferOutput<typeof ConversationResponseSchema>;
export type ConversationListResponse = v.InferOutput<typeof ConversationListResponseSchema>;
export type ConversationMessagesResponse = v.InferOutput<typeof ConversationMessagesResponseSchema>;
export type CreateConversationRequest = v.InferOutput<typeof CreateConversationRequestSchema>;
const parse =
  <Schema extends v.GenericSchema>(schema: Schema) =>
  (value: unknown) => {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? { success: true as const, data: parsed.output }
      : { success: false as const, issues: parsed.issues.map((issue) => issue.message) };
  };
export const parseConversation = parse(ConversationSchema);
export const parseConversationId = parse(OpaqueIdSchema);
export const parseConversationMessage = parse(ConversationMessageSchema);
export const parseCreateConversationRequest = parse(CreateConversationRequestSchema);
export const parseConversationTurnRequest = parse(ConversationTurnRequestSchema);
export const parseConversationResponse = parse(ConversationResponseSchema);
export const parseConversationListResponse = parse(ConversationListResponseSchema);
export const parseConversationMessagesResponse = parse(ConversationMessagesResponseSchema);
export const parseConversationRunResponse = parse(ConversationRunResponseSchema);
