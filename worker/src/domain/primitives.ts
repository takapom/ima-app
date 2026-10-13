import * as v from 'valibot';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})T/;
const isoOffsetPattern = /([+-])(\d{2}):(\d{2})$/;

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const isCalendarDateParts = (year: number, month: number, day: number) => {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  return daysInMonth !== undefined && day <= daysInMonth;
};

/** isoTimestamp は存在しない月日を繰り上げ得るので、暦日かを別に見る。 */
const isIsoCalendarDate = (value: string) => {
  const match = isoDatePattern.exec(value);
  return (
    match !== null && isCalendarDateParts(Number(match[1]), Number(match[2]), Number(match[3]))
  );
};

/** Z 以外は時差14時間まで。それより大きいオフセットは時刻として受け取らない。 */
const isIsoOffset = (value: string) => {
  if (value.endsWith('Z')) return true;
  const match = isoOffsetPattern.exec(value);
  if (match === null) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return hours < 14 || (hours === 14 && minutes === 0);
};

/**
 * 実在する暦日と、UTC または14時間以内の時差を持つ時刻。
 * 文字列が ISO 形であることだけでは通さない。
 */
export const IsoTimestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check(isIsoCalendarDate, 'timestamp contains an invalid calendar date'),
  v.check(isIsoOffset, 'timestamp contains an invalid UTC offset'),
);
export type IsoTimestamp = v.InferOutput<typeof IsoTimestampSchema>;

/**
 * 中身を解釈しない識別子の共通形。種類ごとのスキーマは別名で、候補IDを thread ID として渡さない。
 * Provider のレコード番号や店名をこの識別子へ詰め込まない。
 */
export const OpaqueIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(idPattern),
);

/** 期限付きの探索実行。会話の長期IDとは別で、thread が失効しても会話は残る。 */
export const ThreadIdSchema = OpaqueIdSchema;
/** 1回のモデル実行。会話の発言 sequence とは別物。 */
export const TurnIdSchema = OpaqueIdSchema;
/** 確定した応答。assistant の発言が source で指す。 */
export const ResponseIdSchema = OpaqueIdSchema;
/** Tool 呼び出し。観測IDや会話IDの代わりにしない。 */
export const CallIdSchema = OpaqueIdSchema;
/** owner と thread の中で店舗を指す候補。Provider の recordRef とは別に発行する。 */
export const CandidateIdSchema = OpaqueIdSchema;
/** 1件の観測。候補IDや出典URLではなく、根拠そのものを指す。 */
export const ObservationIdSchema = OpaqueIdSchema;
/** 1回の店舗検索。候補や観測の識別には流用しない。 */
export const SearchIdSchema = OpaqueIdSchema;
/** owner に紐づく保存店舗の参照。店舗本文、写真、生成文は持たない。 */
export const SavedPlaceRefSchema = OpaqueIdSchema;
/** 公開APIの1要求。会話IDや thread ID と混ぜない。 */
export const RequestIdSchema = OpaqueIdSchema;
/** 1回の応答で出したカード集合の ID。履歴参照用（候補レジストリの権限の代わりにはならない）。 */
export const CardSetIdSchema = OpaqueIdSchema;

export type OpaqueId = v.InferOutput<typeof OpaqueIdSchema>;
export type ThreadId = v.InferOutput<typeof ThreadIdSchema>;
export type TurnId = v.InferOutput<typeof TurnIdSchema>;
export type CandidateId = v.InferOutput<typeof CandidateIdSchema>;
export type ObservationId = v.InferOutput<typeof ObservationIdSchema>;
export type SavedPlaceRef = v.InferOutput<typeof SavedPlaceRefSchema>;
export type CardSetId = v.InferOutput<typeof CardSetIdSchema>;

/**
 * 会話行などの改訂番号。1から始まり、楽観的同時実行の期待値に使う。
 * 発言の sequence とは別カウンタであり、0を未作成の印にしない。
 */
export const RevisionSchema = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);

/** このドメイン契約の版。v1 以外は受け取らない。 */
export const SchemaVersionSchema = v.literal('v1');
/**
 * 観測を生んだ能力の版。owner と thread が同じでも、版が違えば同じ観測として再利用しない。
 */
export const CapabilityVersionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

/**
 * 店舗詳細として尋ねる項目。未対応の項目は値を空にせず、FieldResult の unsupported で表す。
 */
export const DetailFieldSchema = v.picklist([
  'identity',
  'opening_hours',
  'price',
  'photos',
  'contact',
  'facilities',
]);
export type DetailField = v.InferOutput<typeof DetailFieldSchema>;

/** 空でない上限付き文字列。上限は項目ごとの契約で渡し、無制限の本文をドメイン値にしない。 */
export const Text = (maxLength: number) =>
  v.pipe(v.string(), v.minLength(1), v.maxLength(maxLength));

/** 未設定を null で表す上限付き文字列。空文字を未設定の代わりにしない。 */
export const NullableText = (maxLength: number) =>
  v.nullable(v.pipe(v.string(), v.maxLength(maxLength)));

/** 画面と出典に出す URL。https 以外は受け取らない。 */
export const HttpsUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.check((value) => /^https:\/\//i.test(value), 'URL must use https'),
);

/** 有限の数。NaN と Infinity を金額や時刻差として通さない。 */
export const FiniteNumberSchema = v.pipe(
  v.number(),
  v.check((value) => Number.isFinite(value), 'number must be finite'),
);
/** 安全整数。精度が落ちる数値を ID や件数として通さない。 */
export const SafeIntegerSchema = v.pipe(FiniteNumberSchema, v.safeInteger());
/** 0以上の有限数。負の金額を不明の代わりに使わない。 */
export const NonNegativeFiniteNumberSchema = v.pipe(FiniteNumberSchema, v.minValue(0));
/** 0以上の安全整数。負数を待ち時間なし、または無制限の意味にしない。 */
export const NonNegativeSafeIntegerSchema = v.pipe(SafeIntegerSchema, v.minValue(0));
