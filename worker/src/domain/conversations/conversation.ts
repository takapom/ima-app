import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/domain/primitives';

export const ConversationSchema = v.pipe(
  v.strictObject({
    conversationId: OpaqueIdSchema,
    ownerScopeRef: OpaqueIdSchema,
    title: Text(80),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    revision: RevisionSchema,
    lastSequence: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.check(
    (value) =>
      Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
      value.lastSequence < value.revision,
    'conversation chronology or revision is inconsistent',
  ),
);
export type Conversation = Readonly<v.InferOutput<typeof ConversationSchema>>;

export const ConversationCursorSchema = v.strictObject({
  updatedAt: IsoTimestampSchema,
  conversationId: OpaqueIdSchema,
});
export type ConversationCursor = v.InferOutput<typeof ConversationCursorSchema>;

export const conversationTitleFromUserText = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length === 0 ? '新しい会話' : Array.from(normalized).slice(0, 40).join('');
};
