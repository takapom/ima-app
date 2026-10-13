import * as v from 'valibot';
import {
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/domain/primitives';
import { RetentionMetadataSchema } from '@worker/core/domain/evidence/retention';

import { ConversationCardsSchema } from '@worker/core/domain/conversations/conversation-cards';
import { retainConversationCards } from '@worker/core/domain/conversations/conversation-card-retention';

/** ユーザーが書いた本文。削除まで残す区分であり、assistant がこの方針を自分の生成文へ付けない。 */
const UserTextSchema = v.strictObject({
  kind: v.literal('user_text'),
  text: v.pipe(
    Text(500),
    v.check((value) => value.trim().length > 0, 'user text is blank'),
  ),
});
/** 保持契約付きの本文。生成文や引用はここを通り、ユーザー原文の無期限保持にはしない。 */
const RetainedTextSchema = v.strictObject({
  kind: v.literal('retained_text'),
  text: Text(500),
  retention: RetentionMetadataSchema,
});
/** 以前あった本文が、期限切れまたは保存不可で表示できないときのプレースホルダ。 */
const UnavailablePartSchema = v.strictObject({
  kind: v.literal('unavailable'),
  reason: v.picklist(['expired', 'policy_withheld']),
});
/** カード集合への参照。表示スナップショット本体が残らないときも、発言位置の参照は残せる。 */
const CardSetReferenceSchema = v.strictObject({
  kind: v.literal('card_set_reference'),
  threadId: OpaqueIdSchema,
  cardSetId: OpaqueIdSchema,
});

/** 発言を構成する部品。ユーザー原文、保持本文、失効跡、カード参照、カードの表示スナップショット。 */
export const ConversationPartSchema = v.variant('kind', [
  UserTextSchema,
  RetainedTextSchema,
  UnavailablePartSchema,
  CardSetReferenceSchema,
  ConversationCardsSchema,
]);
export type ConversationPart = v.InferOutput<typeof ConversationPartSchema>;

/**
 * 保存前の発言。user は user_text か unavailable を1つだけ持ち、responseId を持たない。
 * assistant は responseId を持ち、user_text を載せず、カードの threadId は source の thread と一致させる。
 */
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
/** スキーマを通過した保存前発言。読み取り専用なので、部品の差し替えは新しい値で行う。 */
export type ConversationMessageInput = Readonly<
  v.InferOutput<typeof ConversationMessageInputSchema>
>;

/**
 * 会話に並ぶ1発言。sequence は会話内の発言番号であり、会話行の revision とは別。
 */
export const ConversationMessageSchema = v.strictObject({
  conversationId: OpaqueIdSchema,
  sequence: RevisionSchema,
  createdAt: IsoTimestampSchema,
  message: ConversationMessageInputSchema,
});
/** スキーマを通過した発言。読み取り専用なので、失効は部品を置換した新しい値で表す。 */
export type ConversationMessage = Readonly<v.InferOutput<typeof ConversationMessageSchema>>;

/**
 * 保存の直前と読み出しの直前に通す。店舗事実の鮮度とは別で、過去の発言を引用できるかは保持契約で決める。
 * 入力が契約外なら、成功した空の部品にせず例外にする。
 */
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

/** 発言の全部品へ retainConversationPart を適用する。sequence と messageId は変えない。 */
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
