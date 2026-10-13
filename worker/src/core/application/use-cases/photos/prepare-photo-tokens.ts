import * as v from 'valibot';
import { IsoTimestampSchema, OpaqueIdSchema, RevisionSchema } from '@worker/domain/primitives';
import type { PhotoTokenIssuer } from '@worker/core/application/ports/photo-token-issuer';
/** 写真トークンの発行条件が壊れている。呼び出し側は発行ゼロとして扱わず、準備そのものの失敗として止める。 */
export class PhotoTokenPreparationError extends Error {
  constructor() {
    super('Invalid photo token context');
    this.name = 'PhotoTokenPreparationError';
  }
}
/** カードの写真根拠から切り出した、1枚分の発行判断。photoRef は公開 DTO へ出さない。 */
export type PhotoTokenObservation = {
  readonly candidateId: string;
  readonly photoRef: string;
  /** 表示方針が許すあいだだけトークンへ写す。観測が残っていても表示不可なら発行しない。 */
  readonly displayAllowed: boolean;
  readonly persistUntil?: string | null;
  readonly sessionExpiresAt: string;
  readonly displayUntil: string | null;
  readonly providerExpiresAt: string | null;
};

/** トークンへ焼き込む発行文脈。後続の写真 GET で期限を延ばさない。 */
export type PhotoTokenPreissueContext = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  /** 応答を作ったターン。写真の GET は別の UI ターンで起きうる。 */
  readonly sourceTurnId: string;
  /** 入力時点の対象 revision。コミット後の公開 revision とは別の値としてトークンに残す。 */
  readonly sourceRevision: number;
  readonly deviceId: string;
  readonly now: string;
};

/** 公開 DTO の同期変換が引く、発行済み写真トークン。 */
export type PreparedPhotoTokens = {
  readonly issuedCount: number;
  readonly withheldCount: number;
  /** サーバが発行したトークンだけを返す。provider の写真参照はこの引き当てから出ない。 */
  readonly resolve: (candidateId: string, photoRef: string) => string | undefined;
  /** 永続保存を認められた参照対応のトークンだけを返す。表示専用のトークンを履歴ストアへ渡さない。 */
  readonly resolvePersistent: (candidateId: string, photoRef: string) => string | undefined;
};

const keyFor = (candidateId: string, photoRef: string): string =>
  JSON.stringify([candidateId, photoRef]);

const PhotoTokenContextSchema = v.strictObject({
  ownerScopeRef: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  threadId: OpaqueIdSchema,
  sourceTurnId: OpaqueIdSchema,
  sourceRevision: RevisionSchema,
  deviceId: v.pipe(v.string(), v.minLength(1), v.maxLength(160)),
  now: IsoTimestampSchema,
});

const PhotoTokenObservationSchema = v.strictObject({
  candidateId: OpaqueIdSchema,
  photoRef: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  displayAllowed: v.boolean(),
  persistUntil: v.optional(v.nullable(IsoTimestampSchema), null),
  sessionExpiresAt: IsoTimestampSchema,
  displayUntil: v.nullable(IsoTimestampSchema),
  providerExpiresAt: v.nullable(IsoTimestampSchema),
});

const timestampMilliseconds = (value: string): number | undefined => {
  const parsed = v.safeParse(IsoTimestampSchema, value);
  if (!parsed.success) return undefined;
  const milliseconds = Date.parse(parsed.output);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

type PreparedObservation = {
  readonly candidateId: string;
  readonly photoRef: string;
  readonly expiresAtMilliseconds: number;
  readonly persist: boolean;
};

/**
 * 1件の観測を発行可能な期限へ畳む。
 * 表示不可、期限の解釈不能、すでに切れている観測は発行しない。表示トークンは 30 分を超えて延ばさない。
 */
const prepareObservation = (
  observation: PhotoTokenObservation,
  nowMilliseconds: number,
): PreparedObservation | null => {
  const parsed = v.safeParse(PhotoTokenObservationSchema, observation);
  if (!parsed.success || !parsed.output.displayAllowed || parsed.output.displayUntil === null) {
    return null;
  }
  const bounds = [
    nowMilliseconds + 30 * 60 * 1_000,
    timestampMilliseconds(parsed.output.sessionExpiresAt),
    timestampMilliseconds(parsed.output.displayUntil),
  ];
  if (parsed.output.providerExpiresAt !== null) {
    const providerExpiry = timestampMilliseconds(parsed.output.providerExpiresAt);
    if (providerExpiry === undefined) return null;
    bounds.push(providerExpiry);
  }
  if (parsed.output.persistUntil !== null) bounds.push(Date.parse(parsed.output.persistUntil));
  if (bounds.some((bound) => bound === undefined)) return null;
  const expiresAtMilliseconds = Math.min(
    ...bounds.filter((bound): bound is number => bound !== undefined),
  );
  if (expiresAtMilliseconds <= nowMilliseconds) return null;
  return {
    candidateId: parsed.output.candidateId,
    photoRef: parsed.output.photoRef,
    expiresAtMilliseconds,
    persist: parsed.output.persistUntil !== null,
  };
};

/**
 * 観測中の写真を、公開 DTO の同期変換より前にまとめて発行する。
 * 同じ候補と写真が食い違うときは発行せず、期限と保存可否は厳しい側へ寄せる。
 */
export const preparePhotoTokens = async (
  issuer: PhotoTokenIssuer,
  observations: readonly PhotoTokenObservation[],
  context: PhotoTokenPreissueContext,
): Promise<PreparedPhotoTokens> => {
  const parsedContext = v.safeParse(PhotoTokenContextSchema, {
    ownerScopeRef: context.ownerScopeRef,
    threadId: context.threadId,
    sourceTurnId: context.sourceTurnId,
    sourceRevision: context.sourceRevision,
    deviceId: context.deviceId,
    now: context.now,
  });
  if (!parsedContext.success) throw new PhotoTokenPreparationError();

  const tokens = new Map<string, string>();
  const persistentTokens = new Map<string, string>();
  const prepared = new Map<string, PreparedObservation | null>();
  const nowMilliseconds = Date.parse(parsedContext.output.now);
  for (const observation of observations) {
    const key = keyFor(observation.candidateId, observation.photoRef);
    const next = prepareObservation(observation, nowMilliseconds);
    if (!prepared.has(key)) {
      prepared.set(key, next);
      continue;
    }
    const previous = prepared.get(key);
    if (previous === undefined || previous === null || next === null) {
      prepared.set(key, null);
      continue;
    }
    prepared.set(key, {
      ...previous,
      persist: previous.persist && next.persist,
      expiresAtMilliseconds: Math.min(previous.expiresAtMilliseconds, next.expiresAtMilliseconds),
    });
  }
  let withheldCount = 0;
  for (const [key, observation] of prepared) {
    if (observation === null) {
      withheldCount += 1;
      continue;
    }
    const result = await issuer.issue(
      {
        ownerScopeRef: context.ownerScopeRef,
        threadId: context.threadId,
        turnId: context.sourceTurnId,
        revision: context.sourceRevision,
        deviceId: context.deviceId,
        photoRef: observation.photoRef,
        ...(observation.persist ? { persist: true } : {}),
        expiresAt: new Date(observation.expiresAtMilliseconds).toISOString(),
      },
      context.now,
    );
    if (result.status === 'issued') {
      tokens.set(key, result.token);
      if (observation.persist) persistentTokens.set(key, result.token);
    } else withheldCount += 1;
  }

  return {
    issuedCount: tokens.size,
    withheldCount,
    resolve: (candidateId, photoRef) => tokens.get(keyFor(candidateId, photoRef)),
    resolvePersistent: (candidateId, photoRef) =>
      persistentTokens.get(keyFor(candidateId, photoRef)),
  };
};
