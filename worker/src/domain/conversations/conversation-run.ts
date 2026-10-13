import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema, RevisionSchema } from '@worker/domain/primitives';

/**
 * ユーザー発言1件に対する回答生成の進行。会話の保存単位であり、Thread の中身そのものではない。
 * accepted は受付だけで thread を持たない。running と completed は thread と turn が揃い、completed だけが assistant の発言を持つ。
 * failed と interrupted は失敗の種類が違い、成否不明の生成をどちらかへ丸めて再実行しない。
 */
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

/** スキーマを通過した run。読み取り専用なので、状態遷移は新しい値の置換で行う。 */
export type ConversationRun = Readonly<v.InferOutput<typeof ConversationRunSchema>>;
/** 回答をまだ履歴へ確定していない run。completed、failed、interrupted は対象外。 */
export const runIsPending = (run: ConversationRun): boolean =>
  run.status === 'accepted' || run.status === 'running';
