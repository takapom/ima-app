import * as v from 'valibot';
import {
  CardSetIdSchema,
  CandidateIdSchema,
  OpaqueIdSchema,
  SavedPlaceRefSchema,
  SafeIntegerSchema,
  Text,
} from '@worker/domain/primitives';
import type { CandidateId, CardSetId, OpaqueId } from '@worker/domain/primitives';
import { RegistryScopeSchema, type RegistryScope } from '@worker/domain/evidence/freshness';

/** 保存参照の登録入力。owner に紐づく Provider 識別子だけで、Provider の本文は入れない。 */
export const SavedPlaceRegistrationSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
});
export type SavedPlaceRegistration = v.InferOutput<typeof SavedPlaceRegistrationSchema>;

/** 保存済みの店舗参照。再取得の識別子であり、店名・住所・写真・生成文は持たない。 */
export const SavedPlaceReferenceSchema = v.strictObject({
  savedPlaceRef: SavedPlaceRefSchema,
  ownerScopeRef: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
});
export type SavedPlaceReference = v.InferOutput<typeof SavedPlaceReferenceSchema>;

/**
 * カード集合の1枠。並びの0が hero、以降が alt。
 * 順序と役割が食い違う枠は受け取らない。
 */
export const CardSetEntrySchema = v.strictObject({
  candidateId: CandidateIdSchema,
  displayOrder: v.pipe(SafeIntegerSchema, v.minValue(0), v.maxValue(2)),
  role: v.picklist(['hero', 'alt']),
});
export type CardSetEntry = v.InferOutput<typeof CardSetEntrySchema>;

/**
 * 1回の AI 応答で出したカード集合の記録（会話に残す表示データ ConversationCards とは別物）。
 * hero/alt の順序・選択・除外の整合を v.check で検証する。
 */
export const CardSetRecordSchema = v.pipe(
  v.strictObject({
    cardSetId: CardSetIdSchema,
    scope: RegistryScopeSchema,
    responseId: OpaqueIdSchema,
    entries: v.pipe(v.array(CardSetEntrySchema), v.minLength(1), v.maxLength(3)),
    selectedCandidateId: v.nullable(CandidateIdSchema),
    excludedCandidateIds: v.pipe(v.array(CandidateIdSchema), v.maxLength(3)),
  }),
  v.check((record) => {
    const candidateIds = record.entries.map((entry) => entry.candidateId);
    const excluded = new Set(record.excludedCandidateIds);
    const ordered = record.entries.every(
      (entry, index) =>
        entry.displayOrder === index && entry.role === (index === 0 ? 'hero' : 'alt'),
    );
    const unique = new Set(candidateIds).size === candidateIds.length;
    const excludedInSet = record.excludedCandidateIds.every((id) => candidateIds.includes(id));
    const selectedInSet =
      record.selectedCandidateId === null || candidateIds.includes(record.selectedCandidateId);
    return (
      ordered &&
      unique &&
      excludedInSet &&
      selectedInSet &&
      (record.selectedCandidateId === null || !excluded.has(record.selectedCandidateId))
    );
  }, 'card set order and selection state are inconsistent'),
);
/**
 * 検証済みのカード集合レコード。entries 等は readonly。
 * 履歴表示用。新しい turn で「この候補を使ってよい」という権限の代わりにはならない。
 */
export type CardSetRecord = {
  readonly cardSetId: CardSetId;
  readonly scope: RegistryScope;
  readonly responseId: OpaqueId;
  readonly entries: readonly CardSetEntry[];
  readonly selectedCandidateId: CandidateId | null;
  readonly excludedCandidateIds: readonly CandidateId[];
};
