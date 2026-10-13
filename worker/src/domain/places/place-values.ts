import * as v from 'valibot';
import {
  HttpsUrlSchema,
  IsoTimestampSchema,
  NonNegativeFiniteNumberSchema,
  NonNegativeSafeIntegerSchema,
  Text,
} from '@worker/domain/primitives';

/** 掲載文の最大長。画面には出さず、雰囲気の推測材料として渡す文の上限。 */
export const LISTING_TEXT_MAX_LENGTH = 600;

/**
 * Provider が返した店の同一性。businessStatus が unknown のとき、掲載営業時間から営業中を補わない。
 * listingText は店舗自身の掲載文で、静けさ、席、雰囲気の保証ではない。収集前の観測にはキーが無くてもよい。
 */
export const PlaceIdentitySchema = v.strictObject({
  name: Text(160),
  area: Text(160),
  address: v.nullable(v.pipe(v.string(), v.maxLength(500))),
  category: v.nullable(v.pipe(v.string(), v.maxLength(120))),
  /** 掲載された最寄り駅。null は Provider が駅名を返していないこと。経路文は accessText が別に持つ。 */
  stationName: v.nullable(Text(160)),
  accessText: v.nullable(Text(500)),
  businessStatus: v.picklist([
    'operational',
    'temporarily_closed',
    'permanently_closed',
    'unknown',
  ]),
  sourceUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
  /**
   * 店舗自身の掲載文。雰囲気を推測する材料であり、静けさ、席、雰囲気の保証ではない。
   * 収集前に登録した観測にはキー自体が無い。
   */
  listingText: v.exactOptional(
    v.nullable(v.pipe(v.string(), v.maxLength(LISTING_TEXT_MAX_LENGTH))),
  ),
});
export type PlaceIdentity = v.InferOutput<typeof PlaceIdentitySchema>;

/** endAt が null なのは終了不明ではなく、Provider が終端のない区間を返したとき。終日営業がその例。 */
export const OpeningIntervalSchema = v.pipe(
  v.strictObject({ startAt: IsoTimestampSchema, endAt: v.nullable(IsoTimestampSchema) }),
  v.check(
    (interval) =>
      interval.endAt === null || Date.parse(interval.startAt) <= Date.parse(interval.endAt),
    'opening interval must end at or after it starts',
  ),
);
/**
 * 掲載営業時間の評価結果。listedOpenAtEvaluation は評価時点の掲載上の開閉であり、今営業中や到着時営業の判断ではない。
 * weeklyText は掲載文のまま残し、文からラストオーダーや閉店時刻を作らない。
 */
export const OpeningHoursSchema = v.strictObject({
  timeZone: Text(64),
  intervals: v.array(OpeningIntervalSchema),
  weeklyText: v.array(Text(300)),
  evaluatedAt: IsoTimestampSchema,
  listedOpenAtEvaluation: v.nullable(v.boolean()),
  nextBoundaryAt: v.nullable(IsoTimestampSchema),
  lastOrderAt: v.nullable(IsoTimestampSchema),
  lastOrderRaw: v.nullable(v.pipe(v.string(), v.maxLength(160))),
});
export type OpeningHours = v.InferOutput<typeof OpeningHoursSchema>;

/**
 * 金額の数値範囲。掲載の予算文字列から通貨や一人あたりを補完して作らない。
 */
export const PriceRangeSchema = v.pipe(
  v.strictObject({
    currency: Text(16),
    min: NonNegativeFiniteNumberSchema,
    max: NonNegativeFiniteNumberSchema,
    unit: v.picklist(['per_person', 'per_item', 'unknown']),
  }),
  v.check((range) => range.min <= range.max, 'price range min must not exceed max'),
);
/**
 * 予算の提示。level、range、rawLabel のどれかが Provider 由来で存在するときだけ値になる。
 * rawLabel だけがあるとき、それを解析して range を埋めない。
 */
export const PriceInfoSchema = v.pipe(
  v.strictObject({
    level: v.nullable(NonNegativeSafeIntegerSchema),
    range: v.nullable(PriceRangeSchema),
    rawLabel: v.nullable(v.pipe(v.string(), v.maxLength(160))),
  }),
  v.check(
    (price) => price.level !== null || price.range !== null || price.rawLabel !== null,
    'price value must contain a level, range, or raw label',
  ),
);
export type PriceInfo = v.InferOutput<typeof PriceInfoSchema>;

/** 写真の出典表示。画像本体は持たない。 */
export const PhotoAttributionSchema = v.strictObject({
  displayName: Text(160),
  uri: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
/**
 * 店舗写真の参照。photoRef は取得先を指す識別子で、画像バイトではない。
 * 永続ストレージへ画像本体を置く形にはしない。
 */
export const PhotoSchema = v.strictObject({
  photoRef: Text(512),
  attributions: v.array(PhotoAttributionSchema),
  sourceUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
/** 写真参照の集合。画像本体は持たない。サイズ違いを別写真にしない判断は Adapter が行い、この型は参照をまとめるだけ。 */
export const PhotoInfoSchema = v.strictObject({
  photos: v.pipe(v.array(PhotoSchema), v.maxLength(3)),
});

/**
 * 連絡先の値。モデルへ渡すか保存するかは保持方針が決め、この型は電話番号と URL の形だけを持つ。
 */
export const ContactInfoSchema = v.strictObject({
  websiteUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
  phone: v.nullable(v.pipe(v.string(), v.maxLength(64))),
  mapUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});

/**
 * 設備の有無。yes、no、partial、unknown は同一視しない。
 * sourceText は掲載の抜粋であり、設備ありの結論に読み替えない。
 */
export const FacilitiesInfoSchema = v.strictObject({
  wifi: v.picklist(['yes', 'no', 'partial', 'unknown']),
  nonSmoking: v.picklist(['yes', 'no', 'partial', 'unknown']),
  privateRoom: v.picklist(['yes', 'no', 'partial', 'unknown']),
  parking: v.picklist(['yes', 'no', 'partial', 'unknown']),
  sourceText: v.array(Text(300)),
});
