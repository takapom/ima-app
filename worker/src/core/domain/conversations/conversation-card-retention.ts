import type { ConversationCards } from '@worker/core/domain/conversations/conversation-cards';
import type { RetentionMetadata } from '@worker/domain/evidence/retention';
type Card = ConversationCards['cards']['hero'];

/** 保持ポリシーに書かれた期限のうち、いちばん早い時刻（ミリ秒）。null は「期限なし」なので計算に入れない。 */
const deadline = (policy: RetentionMetadata): number =>
  Math.min(
    ...[
      policy.sessionExpiresAt,
      policy.displayUntil,
      policy.retentionUntil,
      policy.deletionScheduledAt,
    ]
      .filter((value) => value !== null)
      .map(Date.parse),
  );
/**
 * 今の時刻 now で、この内容を表示してよいか判定する。
 * 期限切れなら 'expired'。ポリシーで保存・表示不可なら 'policy_withheld'。表示してよいなら null。
 */
const unavailable = (
  policy: RetentionMetadata,
  now: string,
): 'expired' | 'policy_withheld' | null => {
  if (
    policy.policyStatus === 'expired' ||
    policy.displayPolicyStatus === 'expired' ||
    Date.parse(now) >= deadline(policy)
  )
    return 'expired';
  return policy.retentionDecision === 'allow' &&
    policy.restoreMode === 'full' &&
    policy.policyStatus === 'available' &&
    policy.displayPolicyStatus === 'available' &&
    policy.retentionUntil !== null &&
    policy.deletionScheduledAt !== null
    ? null
    : 'policy_withheld';
};
/** 表示できないときユーザーに見せる短い理由。期限切れと「保存不可」で文言を分ける。 */
const reason = (value: 'expired' | 'policy_withheld') =>
  value === 'expired' ? '保存期限が過ぎています' : '保存が許可されていません';
/** 店舗 fact（identity など）。根拠 evidence のどれかが期限切れなら status を unknown にし、値は見せない。 */
const retainField = <T extends NonNullable<Card['facts'][keyof Card['facts']]>>(
  field: T,
  now: string,
) => {
  if (field?.status !== 'known') return field;
  const failure = field.evidence
    .map((entry) => unavailable(entry.retention, now))
    .find((value) => value !== null);
  return failure === undefined ? field : { status: 'unknown' as const, reason: reason(failure) };
};
/** カードの why / diff（AI の説明文）。出せなければ reason() の短文に差し替え、出典は消す。 */
const retainText = (text: Card['why'], now: string): Card['why'] => {
  const failure = unavailable(text.retention, now);
  return failure === null
    ? text
    : {
        text: reason(failure),
        retention: { ...text.retention, attribution: null, displayPolicyStatus: failure },
      };
};
/**
 * 写真 fact。通常の retainField に加え、カード全体の photosExpireAt を過ぎたら出さない。
 * photosExpireAt が null なら「いつまで出せるか分からない」として unknown にする。
 */
const retainPhotos = (
  field: NonNullable<Card['facts']['photos']>,
  expiresAt: string | null,
  now: string,
): NonNullable<Card['facts']['photos']> => {
  const retained = retainField(field, now);
  if (retained.status !== 'known' || retained.value.photos.length === 0) return retained;
  if (expiresAt === null) return { status: 'unknown', reason: '写真の表示期限を確認できません' };
  return Date.parse(now) < Date.parse(expiresAt)
    ? retained
    : { status: 'unknown', reason: '写真の表示期限が過ぎています' };
};
/**
 * 会話に保存・表示する直前に、期限切れの店舗情報や説明文を間引く。
 * hero と alt の各カードに retainCard を当て、now はサーバー現在時刻（ISO 文字列）。
 */
export const retainConversationCards = (
  part: ConversationCards,
  now: string,
): ConversationCards => {
  const keepPhotos =
    part.photosExpireAt !== null && Date.parse(now) < Date.parse(part.photosExpireAt);
  const retainCard = (card: Card): Card => {
    const retained = structuredClone(card);
    /** facts はフィールドごとに代入する（まとめて代入すると TypeScript の型チェックが通らない）。 */
    retained.facts.identity = retainField(card.facts.identity, now);
    if (card.facts.opening_hours !== undefined)
      retained.facts.opening_hours = retainField(card.facts.opening_hours, now);
    if (card.facts.price !== undefined) retained.facts.price = retainField(card.facts.price, now);
    if (card.facts.contact !== undefined)
      retained.facts.contact = retainField(card.facts.contact, now);
    if (card.facts.facilities !== undefined)
      retained.facts.facilities = retainField(card.facts.facilities, now);
    if (card.facts.photos !== undefined)
      retained.facts.photos = retainPhotos(card.facts.photos, part.photosExpireAt, now);
    retained.why = retainText(card.why, now);
    if (card.diff !== undefined) retained.diff = retainText(card.diff, now);
    return retained;
  };
  return {
    ...part,
    photosExpireAt: keepPhotos ? part.photosExpireAt : null,
    cards: { hero: retainCard(part.cards.hero), alts: part.cards.alts.map(retainCard) },
  };
};
/**
 * このカードセットで「まだ表示できる」とみなせる期限時刻をすべて集める（ミリ秒）。
 * セッション終了や削除のスケジュール用。ここでは期限を延長したりはしない。
 */
export const conversationCardsDeadlines = (part: ConversationCards): number[] => {
  const values: number[] = [];
  for (const card of [part.cards.hero, ...part.cards.alts]) {
    for (const field of Object.values(card.facts))
      if (field?.status === 'known')
        for (const evidence of field.evidence) values.push(deadline(evidence.retention));
    for (const text of [card.why, card.diff])
      if (text?.retention.displayPolicyStatus === 'available')
        values.push(deadline(text.retention));
    if (card.facts.photos?.status === 'known' && part.photosExpireAt !== null)
      values.push(Date.parse(part.photosExpireAt));
  }
  return values;
};
