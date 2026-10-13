import * as v from 'valibot';
import {
  HttpsUrlSchema,
  IsoTimestampSchema,
  OpaqueIdSchema,
  RevisionSchema,
  Text,
} from '@worker/domain/primitives';
import { RetentionMetadataSchema } from '@worker/core/domain/evidence/retention';
import {
  PlaceIdentitySchema,
  OpeningHoursSchema,
  PriceInfoSchema,
  PhotoAttributionSchema,
  ContactInfoSchema,
  FacilitiesInfoSchema,
} from '@worker/domain/places/place-values';

/** カード表示用の出典。クレジットを生成文の中へ埋め込まない。 */
const Attribution = v.strictObject({
  label: Text(160),
  sourceLink: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
/** カード上の「根拠」1件。観測 ID と出典・保持期限の写し（レジストリ本体は別）。 */
const Evidence = v.strictObject({
  evidenceId: OpaqueIdSchema,
  attribution: v.nullable(Attribution),
  attributions: v.optional(v.pipe(v.array(Attribution), v.minLength(1), v.maxLength(9))),
  retention: RetentionMetadataSchema,
});
/**
 * カード上の1項目（店名・営業時間など）の表示形。
 * known なら value と evidence 配列あり。それ以外は理由文だけ。
 */
const field = <T extends v.GenericSchema>(value: T) =>
  v.variant('status', [
    v.strictObject({
      status: v.literal('known'),
      value,
      evidence: v.pipe(v.array(Evidence), v.minLength(1)),
    }),
    v.strictObject({
      status: v.picklist(['unknown', 'unsupported', 'not_applicable']),
      reason: Text(300),
    }),
    v.strictObject({
      status: v.literal('error'),
      code: v.picklist(['PROVIDER_UNAVAILABLE', 'MISSING_EVIDENCE', 'INTERNAL']),
      reason: Text(300),
    }),
  ]);
/** 生成文と、その文に継承した保持契約。店舗事実の観測ではない。 */
const text = (max: number) =>
  v.strictObject({ text: Text(max), retention: RetentionMetadataSchema });
/**
 * 1枚の表示カード。identity から listingText を外すのは、掲載文をカードの事実として見せないため。
 * why と diff はモデルの生成文であり、店舗事実の観測ではない。
 */
const Card = v.strictObject({
  candidateId: OpaqueIdSchema,
  facts: v.strictObject({
    identity: field(v.omit(PlaceIdentitySchema, ['listingText'])),
    opening_hours: v.optional(field(OpeningHoursSchema)),
    price: v.optional(field(PriceInfoSchema)),
    photos: v.optional(
      field(
        v.strictObject({
          photos: v.pipe(
            v.array(
              v.strictObject({
                photoToken: Text(512),
                attributions: v.array(PhotoAttributionSchema),
                sourceUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
              }),
            ),
            v.maxLength(3),
          ),
          partialReason: v.optional(Text(300)),
        }),
      ),
    ),
    contact: v.optional(field(ContactInfoSchema)),
    facilities: v.optional(field(FacilitiesInfoSchema)),
  }),
  why: text(80),
  diff: v.optional(text(40)),
});
/**
 * 会話履歴に残す「その時点のカード画面」の写し。
 * 候補レジストリの代わりにはならない（あくまで過去の表示用）。
 */
export const ConversationCardsSchema = v.strictObject({
  kind: v.literal('card_set'),
  threadId: OpaqueIdSchema,
  cardSetId: OpaqueIdSchema,
  revision: RevisionSchema,
  photosExpireAt: v.nullable(IsoTimestampSchema),
  /** 本文の期限後も残るホットペッパーの店舗参照。会話の削除と一緒に除く。画像本体や観測期限の延長には使わない。 */
  photoSources: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          candidateId: OpaqueIdSchema,
          provider: v.literal('hotpepper'),
          recordRef: v.pipe(v.string(), v.regex(/^J[0-9]+$/), v.maxLength(128)),
        }),
      ),
      v.maxLength(3),
    ),
  ),
  cards: v.strictObject({ hero: Card, alts: v.pipe(v.array(Card), v.maxLength(2)) }),
});
export type ConversationCards = v.InferOutput<typeof ConversationCardsSchema>;
/** 履歴から現在写真を取り直すための店舗参照。画像本体や過去の観測期限は持たない。 */
export type ConversationPhotoSource = NonNullable<ConversationCards['photoSources']>[number];
