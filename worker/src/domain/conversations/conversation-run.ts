import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema, RevisionSchema } from '@worker/domain/primitives';

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

export type ConversationRun = Readonly<v.InferOutput<typeof ConversationRunSchema>>;
export const runIsPending = (run: ConversationRun): boolean =>
  run.status === 'accepted' || run.status === 'running';
