import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/domain/primitives';

/** Quotations of past speech, never evidence for current candidates or tool arguments. */
export const ConversationMemorySchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  conversationId: OpaqueIdSchema,
  beforeSequence: RevisionSchema,
  summary: v.optional(
    v.nullable(
      v.strictObject({
        version: v.literal('extractive_v1'),
        throughSequence: RevisionSchema,
        excerpts: v.pipe(
          v.array(
            v.strictObject({
              messageId: OpaqueIdSchema,
              sequence: RevisionSchema,
              text: Text(320),
            }),
          ),
          v.minLength(1),
          v.maxLength(8),
        ),
      }),
    ),
  ),
  entries: v.pipe(
    v.array(
      v.strictObject({
        messageId: OpaqueIdSchema,
        sequence: RevisionSchema,
        role: v.picklist(['user', 'assistant']),
        text: Text(500),
        sourceThreadId: v.nullable(OpaqueIdSchema),
        expiresAt: v.nullable(IsoTimestampSchema),
      }),
    ),
    v.maxLength(32),
  ),
});
export type ConversationMemory = v.InferOutput<typeof ConversationMemorySchema>;
