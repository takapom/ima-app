import * as v from 'valibot';
import type { Observation, SourceRef } from '@worker/core/domain/evidence/evidence';
import type { ObservationContext, RegistryScope } from '@worker/core/domain/evidence/freshness';
import type { RetentionMetadata } from '@worker/core/domain/evidence/retention';
import { OpaqueIdSchema, Text } from '@worker/core/domain/primitives';
import type {
  CandidateId,
  IsoTimestamp,
  ObservationId,
  OpaqueId,
} from '@worker/core/domain/primitives';

/** 候補に写した営業状態。掲載営業時間から営業中を推測して operational にしない。 */
export const CandidateStatusSchema = v.picklist([
  'operational',
  'temporarily_closed',
  'permanently_closed',
  'unknown',
]);
export type CandidateStatus = v.InferOutput<typeof CandidateStatusSchema>;

/** Provider 側の店舗識別。候補IDとは別で、保存参照にもこの組だけを残す。本文は含めない。 */
export const ProviderRecordIdentitySchema = v.strictObject({
  provider: Text(80),
  recordRef: Text(512),
});
export type ProviderRecordIdentity = v.InferOutput<typeof ProviderRecordIdentitySchema>;

/**
 * 候補レジストリへ新規登録するときの入力。owner と thread の組に限定する。
 */
export const CandidateRegistrationSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  threadId: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
  displayName: Text(160),
  status: CandidateStatusSchema,
});
export type CandidateRegistration = v.InferOutput<typeof CandidateRegistrationSchema>;

/**
 * 登録済み候補。placeRef は内部の場所参照。excluded は提示から外した印であり、閉店ではない。
 */
export type CandidateRecord = CandidateRegistration & {
  candidateId: CandidateId;
  placeRef: OpaqueId;
  excluded: boolean;
};

/** レジストリに保存できる観測値の JSON 形。関数や undefined は入れない。 */
export type RegistryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RegistryJsonValue[]
  | { readonly [key: string]: RegistryJsonValue };

/**
 * レジストリに保存済みの観測。freshUntil と context が必須（欠けている観測はそのまま使わない）。
 */
export type StoredObservation = Observation<RegistryJsonValue> & {
  freshUntil: IsoTimestamp;
  context: ObservationContext;
};
/** 保存済み観測の読み取り専用型。呼び出し側が中身を書き換えないようにする。 */
export type ReadonlyStoredObservation = Readonly<StoredObservation>;

/**
 * 観測1件の登録要求。出典と保持契約を含む。
 * 観測を1件登録するときの入力。scope と context の owner/thread が一致しないと拒否される。
 */
export type ObservationRegistration = {
  scope: RegistryScope;
  candidateId: CandidateId;
  field: string;
  value: RegistryJsonValue;
  basis: 'provider_reported' | 'computed';
  sourceUpdatedAt: string | null;
  freshUntil: string;
  expiresAt: string;
  context: ObservationContext;
  sources: readonly SourceRef[];
  retention: RetentionMetadata;
};

/** 同じ候補の同じ項目を再利用できるか調べる問い合わせ。observationId があればその1件に絞る。 */
export type ObservationReuseQuery = {
  scope: RegistryScope;
  candidateId: CandidateId;
  field: string;
  context: ObservationContext;
  observationId?: ObservationId;
};

/**
 * 「この観測を今の turn で使えるか」の判定結果。
 * reusable 以外は missing / expired / context_mismatch / conflict（複数候補が競合）のいずれか。
 */
export type ObservationReuseResult =
  | {
      status: 'reusable';
      observation: ReadonlyStoredObservation;
    }
  | { status: 'missing' | 'expired' | 'context_mismatch' }
  | {
      status: 'conflict';
      observations: readonly ReadonlyStoredObservation[];
    };

/**
 * 候補レジストリ操作のエラー種別。HTTP 層は message ではなく code で分岐する。
 */
export type RegistryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_CLOCK'
  | 'INVALID_ID'
  | 'DUPLICATE_ID'
  | 'OWNER_SCOPE_MISMATCH'
  | 'THREAD_SCOPE_MISMATCH'
  | 'UNKNOWN_CANDIDATE'
  | 'INVALID_OBSERVATION';

/** レジストリでの検証エラー。code フィールドがエラー種別。 */
export class RegistryError extends Error {
  readonly code: RegistryErrorCode;

  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}
