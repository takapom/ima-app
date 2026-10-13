import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/core/domain/primitives';

/**
 * owner に属する会話。期限付き thread とは別IDで、thread が失効しても会話は残る。
 * revision は会話行の改訂、lastSequence は最後の発言番号。作成直後は発言が無く revision が 1。
 * 発言番号を改訂番号として読まない。
 */
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
/** スキーマを通過した会話。読み取り専用なので、保持側は置換で更新する。 */
export type Conversation = Readonly<v.InferOutput<typeof ConversationSchema>>;

/**
 * 会話一覧のキーセット。更新時刻と会話IDで位置を表す。
 * 閲覧だけでは順番を変えない。
 */
export const ConversationCursorSchema = v.strictObject({
  updatedAt: IsoTimestampSchema,
  conversationId: OpaqueIdSchema,
});
export type ConversationCursor = v.InferOutput<typeof ConversationCursorSchema>;

/**
 * 初期タイトルは最初のユーザー原文から作る。空白は1つに畳み、空なら「新しい会話」。
 * モデルの要約をタイトルにしない。
 */
export const conversationTitleFromUserText = (text: string): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length === 0 ? '新しい会話' : Array.from(normalized).slice(0, 40).join('');
};
