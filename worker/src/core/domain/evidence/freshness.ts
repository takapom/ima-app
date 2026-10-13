import * as v from 'valibot';
import {
  CapabilityVersionSchema,
  OpaqueIdSchema,
  SafeIntegerSchema,
  Text,
  ThreadIdSchema,
} from '@worker/domain/primitives';

/** 位置の改訂。取得時と違う位置改訂を、同じ場所の事実として再利用しない。 */
export const LocationRevisionSchema = v.pipe(SafeIntegerSchema, v.minValue(0));
export type LocationRevision = v.InferOutput<typeof LocationRevisionSchema>;

/**
 * 1人の owner と1つの thread に限って観測を再利用してよい条件。
 * 別 owner や別 thread では、店と項目が同じでも再利用しない。
 */
export const ObservationContextSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
  capabilityVersion: CapabilityVersionSchema,
  locationRevision: LocationRevisionSchema,
  timeContext: Text(160),
});
export type ObservationContext = v.InferOutput<typeof ObservationContextSchema>;

/**
 * 候補・観測が属する範囲（どのユーザーのどの会話スレッドか）。
 * 再利用可否はこの2項目だけでなく ObservationContext 全体で決める。
 */
export const RegistryScopeSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: ThreadIdSchema,
});
export type RegistryScope = v.InferOutput<typeof RegistryScopeSchema>;

/**
 * 観測を事実として再利用できるか。freshUntil と expiresAt の両方より前のときだけ fresh。
 * 鮮度切れは再取得済みでも表示可能でもない。
 */
export type ObservationFreshness = 'fresh' | 'expired';

/** contextKey と一致判定の材料。契約版と項目名を含めるので、版や項目が違えば別キーになる。 */
function contextValues(context: ObservationContext, field: string): readonly string[] {
  return [
    'v1',
    field,
    context.ownerScopeRef,
    context.threadId,
    context.capabilityVersion,
    String(context.locationRevision),
    context.timeContext,
  ];
}

/** 索引用の32bit混合。同じ文字列を同じキーにするための計算であり、改ざん検出には使わない。 */
function hash32(value: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * 観測を DB 等で引くための短いキー（ハッシュ）。同じ文脈なら同じキーになる。
 * キーが一致しても再利用 OK とは限らない。最終判断は matchesObservationContext で行う。
 */
export function contextKeyForObservation(context: ObservationContext, field: string): string {
  const canonical = JSON.stringify(contextValues(context, field));
  const left = hash32(canonical, 2_166_136_261).toString(16).padStart(8, '0');
  const right = hash32(canonical, 2_654_435_761).toString(16).padStart(8, '0');
  return `v1-${left}-${right}`;
}

/**
 * 保存済みの ObservationContext と、今の turn が求める context が同じか。
 * owner・thread・能力版・位置・時間の5点を比較する（観測の field 名はここでは見ない）。
 */
export function matchesObservationContext(
  actual: ObservationContext,
  expected: ObservationContext,
): boolean {
  const actualValues = contextValues(actual, 'context');
  const expectedValues = contextValues(expected, 'context');
  return actualValues.every((value, index) => value === expectedValues[index]);
}

/**
 * now が freshUntil と expiresAt のどちらよりも前なら fresh。期限ちょうども expired。
 * 片方だけ残っていても fresh にしない。
 */
export function observationFreshness(
  observation: { freshUntil: string; expiresAt: string },
  now: string,
): ObservationFreshness {
  return Date.parse(now) < Date.parse(observation.freshUntil) &&
    Date.parse(now) < Date.parse(observation.expiresAt)
    ? 'fresh'
    : 'expired';
}
