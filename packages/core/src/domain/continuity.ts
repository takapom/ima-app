import * as v from 'valibot';
import {
  CardSetIdSchema,
  CandidateIdSchema,
  OpaqueIdSchema,
  SavedPlaceRefSchema,
  SafeIntegerSchema,
  Text,
} from './primitives';
import type { CandidateId, CardSetId, OpaqueId } from './primitives';
import { RegistryScopeSchema, type RegistryScope } from './freshness';

/** A saved reference contains only an owner-scoped provider identity, never provider payload. */
export const SavedPlaceRegistrationSchema = v.strictObject({
  ownerScopeRef: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
});
export type SavedPlaceRegistration = v.InferOutput<typeof SavedPlaceRegistrationSchema>;

export const SavedPlaceReferenceSchema = v.strictObject({
  savedPlaceRef: SavedPlaceRefSchema,
  ownerScopeRef: OpaqueIdSchema,
  provider: Text(80),
  recordRef: Text(512),
});
export type SavedPlaceReference = v.InferOutput<typeof SavedPlaceReferenceSchema>;

export const CardSetEntrySchema = v.strictObject({
  candidateId: CandidateIdSchema,
  displayOrder: v.pipe(SafeIntegerSchema, v.minValue(0), v.maxValue(2)),
  role: v.picklist(['hero', 'alt']),
});
export type CardSetEntry = v.InferOutput<typeof CardSetEntrySchema>;

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
export type CardSetRecord = {
  readonly cardSetId: CardSetId;
  readonly scope: RegistryScope;
  readonly responseId: OpaqueId;
  readonly entries: readonly CardSetEntry[];
  readonly selectedCandidateId: CandidateId | null;
  readonly excludedCandidateIds: readonly CandidateId[];
};
