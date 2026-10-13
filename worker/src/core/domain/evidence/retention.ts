import * as v from 'valibot';
import { HttpsUrlSchema, IsoTimestampSchema, Text } from '@worker/domain/primitives';

/** 表示用の出典。保持期限の計算には使わず、クレジットの文言とリンクだけを持つ。 */
export const AttributionSchema = v.strictObject({
  label: Text(160),
  sourceLink: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export type Attribution = v.InferOutput<typeof AttributionSchema>;

/**
 * 本文を保存してよいか。unknown は許可でも拒否でもなく、保存しない側へ倒す材料にする。
 */
export const RetentionDecisionSchema = v.picklist(['allow', 'deny', 'unknown']);
export type RetentionDecision = v.InferOutput<typeof RetentionDecisionSchema>;

/**
 * 何をどの範囲で残すか。identifier_indefinite_owner_scoped は owner の参照だけで、Provider の本文や写真を無期限に残すモードではない。
 * none は保持しない。session_only は今夜の session を超えて残さない。
 */
export const RetentionModeSchema = v.picklist([
  'provider_limited',
  'identifier_indefinite_owner_scoped',
  'session_only',
  'none',
]);
export type RetentionMode = v.InferOutput<typeof RetentionModeSchema>;

/**
 * 復元時に本文を戻せるか。reference_only は再取得用の参照だけで、full の本文復元として扱わない。
 */
export const RestoreModeSchema = v.picklist(['full', 'reference_only', 'unavailable']);
export type RestoreMode = v.InferOutput<typeof RestoreModeSchema>;

/**
 * 保持や表示を止める理由。policy_withheld、attribution_missing、expired は同じ欠落にまとめない。
 * disabled_m35 と disabled_capability は機能停止であり、期限切れではない。
 */
export const PolicyStatusSchema = v.picklist([
  'available',
  'policy_withheld',
  'disabled_m35',
  'disabled_capability',
  'attribution_missing',
  'expired',
]);
export type PolicyStatus = v.InferOutput<typeof PolicyStatusSchema>;
/** 表示だけの可否。保存の policyStatus とは別に持ち、保存できても表示できない状態を潰さない。 */
export const DisplayPolicyStatusSchema = PolicyStatusSchema;

/** 片方が null なら順序違反にしない。null を無限の未来として比較しない。 */
const atOrBefore = (left: string | null, right: string | null) =>
  left === null || right === null || Date.parse(left) <= Date.parse(right);

/**
 * 1つのデータの保持契約。allow は期限と削除予定が揃ったときだけ通り、無期限の識別子モードは本文の期限を持たない。
 * 許可と期限が矛盾する値は拒否する。窓を短くする処理は narrowRetention と capRetention が行う。
 */
export const RetentionMetadataSchema = v.pipe(
  v.strictObject({
    retentionDecision: RetentionDecisionSchema,
    retentionMode: RetentionModeSchema,
    sessionExpiresAt: IsoTimestampSchema,
    freshUntil: v.nullable(IsoTimestampSchema),
    displayUntil: v.nullable(IsoTimestampSchema),
    retentionUntil: v.nullable(IsoTimestampSchema),
    deletionScheduledAt: v.nullable(IsoTimestampSchema),
    attribution: v.nullable(AttributionSchema),
    restoreMode: RestoreModeSchema,
    policyStatus: PolicyStatusSchema,
    displayPolicyStatus: DisplayPolicyStatusSchema,
  }),
  v.check((metadata) => {
    const indefinite = metadata.retentionMode === 'identifier_indefinite_owner_scoped';
    const windowsFitSession =
      atOrBefore(metadata.freshUntil, metadata.sessionExpiresAt) &&
      atOrBefore(metadata.displayUntil, metadata.sessionExpiresAt) &&
      atOrBefore(metadata.retentionUntil, metadata.sessionExpiresAt) &&
      atOrBefore(metadata.freshUntil, metadata.displayUntil);

    if (!windowsFitSession) return false;

    if (metadata.retentionDecision === 'allow') {
      if (
        metadata.policyStatus !== 'available' ||
        metadata.retentionMode === 'none' ||
        metadata.restoreMode === 'unavailable'
      ) {
        return false;
      }
      if (indefinite) {
        return (
          metadata.retentionUntil === null &&
          metadata.freshUntil === null &&
          metadata.displayUntil === null &&
          metadata.deletionScheduledAt === null &&
          metadata.restoreMode === 'reference_only'
        );
      }
      return (
        metadata.retentionUntil !== null &&
        metadata.deletionScheduledAt !== null &&
        (metadata.freshUntil === null || metadata.displayUntil !== null) &&
        atOrBefore(metadata.freshUntil, metadata.displayUntil) &&
        atOrBefore(metadata.displayUntil, metadata.retentionUntil) &&
        atOrBefore(metadata.deletionScheduledAt, metadata.retentionUntil)
      );
    }

    return (
      metadata.retentionUntil === null &&
      metadata.deletionScheduledAt === null &&
      metadata.restoreMode !== 'full' &&
      !indefinite
    );
  }, 'retention decision and expiry are inconsistent'),
);
export type RetentionMetadata = v.InferOutput<typeof RetentionMetadataSchema>;

/** 最も早い期限。null は候補に入れないので、他の期限を延ばさない。 */
const earliestOf = (values: readonly (string | null)[]): string | null => {
  let earliest: string | null = null;
  for (const value of values) {
    if (value !== null && (earliest === null || Date.parse(value) < Date.parse(earliest))) {
      earliest = value;
    }
  }
  return earliest;
};

/** available 以外の最初の状態。後続の available で上書きしない。 */
const firstRestricted = <Status extends string>(
  values: readonly Status[],
  open: Status,
): Status | undefined => values.find((value) => value !== open);

/** 保存できないときの保持契約。本文は session 末で消え、復元もしない。判定不能を allow にしない。 */
const denyRetentionUntil = (sessionExpiresAt: string): RetentionMetadata => ({
  retentionDecision: 'deny',
  retentionMode: 'session_only',
  sessionExpiresAt,
  freshUntil: null,
  displayUntil: null,
  retentionUntil: null,
  deletionScheduledAt: null,
  attribution: null,
  restoreMode: 'unavailable',
  policyStatus: 'policy_withheld',
  displayPolicyStatus: 'policy_withheld',
});

/**
 * 複数の入力から作った本文の保持。いずれかの期限より遅くせず、全部が保存できて表示できるときだけ保存し表示する。
 * null の期限はその入力が期限を課さないという意味であり、他の入力の期限を延ばさない。
 * 無期限の識別子参照は本文の保存元にしない。検査に失敗した合成結果は拒否側へ倒す。
 */
export const narrowRetention = (
  base: RetentionMetadata,
  sources: readonly RetentionMetadata[],
): RetentionMetadata => {
  const all = [base, ...sources];
  const sessionExpiresAt =
    earliestOf(all.map((item) => item.sessionExpiresAt)) ?? base.sessionExpiresAt;
  const storable = all.every(
    (item) =>
      item.retentionDecision === 'allow' &&
      item.retentionMode !== 'identifier_indefinite_owner_scoped' &&
      item.retentionUntil !== null &&
      item.deletionScheduledAt !== null,
  );
  const cap = (value: string | null, bound: string | null) => earliestOf([value, bound]) ?? value;
  const retentionUntil = storable
    ? cap(earliestOf(all.map((item) => item.retentionUntil)), sessionExpiresAt)
    : null;
  const deletionScheduledAt = storable
    ? cap(earliestOf(all.map((item) => item.deletionScheduledAt)), retentionUntil)
    : null;
  const listedDisplayUntil = cap(
    cap(earliestOf(all.map((item) => item.displayUntil)), retentionUntil),
    sessionExpiresAt,
  );
  const freshUntil = cap(
    cap(earliestOf(all.map((item) => item.freshUntil)), listedDisplayUntil),
    sessionExpiresAt,
  );
  /** 鮮度期限のある保存本文には、表示期限も要る。 */
  const displayUntil =
    storable && freshUntil !== null ? (listedDisplayUntil ?? retentionUntil) : listedDisplayUntil;
  const displayPolicyStatus =
    firstRestricted(
      all.map((item) => item.displayPolicyStatus),
      'available',
    ) ?? 'available';
  const narrowed: RetentionMetadata = storable
    ? {
        retentionDecision: 'allow',
        retentionMode: all.some((item) => item.retentionMode === 'session_only')
          ? 'session_only'
          : 'provider_limited',
        sessionExpiresAt,
        freshUntil,
        displayUntil,
        retentionUntil,
        deletionScheduledAt,
        attribution:
          base.attribution ??
          sources.find((item) => item.attribution !== null)?.attribution ??
          null,
        restoreMode: all.some((item) => item.restoreMode !== 'full') ? 'reference_only' : 'full',
        policyStatus: 'available',
        displayPolicyStatus,
      }
    : {
        retentionDecision: all.some((item) => item.retentionDecision === 'deny')
          ? 'deny'
          : all.some((item) => item.retentionDecision === 'unknown')
            ? 'unknown'
            : 'deny',
        retentionMode: all.some((item) => item.retentionMode === 'none') ? 'none' : 'session_only',
        sessionExpiresAt,
        freshUntil,
        displayUntil,
        retentionUntil: null,
        deletionScheduledAt: null,
        attribution:
          base.attribution ??
          sources.find((item) => item.attribution !== null)?.attribution ??
          null,
        restoreMode: all.some((item) => item.restoreMode === 'unavailable')
          ? 'unavailable'
          : 'reference_only',
        policyStatus:
          firstRestricted(
            all.map((item) => item.policyStatus),
            'available',
          ) ?? 'policy_withheld',
        displayPolicyStatus,
      };
  const parsed = v.safeParse(RetentionMetadataSchema, narrowed);
  return parsed.success ? parsed.output : denyRetentionUntil(sessionExpiresAt);
};

/**
 * 引用した発言の期限など、指定時刻より遅い窓を切る。切った結果が契約を満たさなければ保存しない。
 */
export const capRetention = (retention: RetentionMetadata, deadline: string): RetentionMetadata => {
  const cap = (value: string | null) =>
    value === null || Date.parse(value) <= Date.parse(deadline) ? value : deadline;
  const sessionExpiresAt = cap(retention.sessionExpiresAt) ?? deadline;
  const parsed = v.safeParse(RetentionMetadataSchema, {
    ...retention,
    sessionExpiresAt,
    freshUntil: cap(retention.freshUntil),
    displayUntil: cap(retention.displayUntil),
    retentionUntil: cap(retention.retentionUntil),
    deletionScheduledAt: cap(retention.deletionScheduledAt),
  });
  return parsed.success ? parsed.output : denyRetentionUntil(sessionExpiresAt);
};
