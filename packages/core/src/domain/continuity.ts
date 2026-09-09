import * as v from 'valibot';
import { AnyFieldResultSchema } from './result';
import type { Issue } from './issue';
import {
  CardSetIdSchema,
  CandidateIdSchema,
  OpaqueIdSchema,
  SavedPlaceRefSchema,
  SafeIntegerSchema,
  Text,
} from './primitives';
import { CandidateStatusSchema } from './registry';
import type { CandidateId, CardSetId, DetailField, OpaqueId } from './primitives';
import type { ReadonlyStoredObservation } from './registry';
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

export const SavedPlaceCandidateDetailsSchema = v.strictObject({
  displayName: Text(160),
  status: CandidateStatusSchema,
});
export type SavedPlaceCandidateDetails = v.InferOutput<typeof SavedPlaceCandidateDetailsSchema>;

export const CardSetRegistrationSchema = v.strictObject({
  scope: RegistryScopeSchema,
  responseId: OpaqueIdSchema,
  candidateIds: v.pipe(
    v.array(CandidateIdSchema),
    v.minLength(1),
    v.maxLength(3),
    v.check((ids) => new Set(ids).size === ids.length, 'card set candidates must be unique'),
  ),
});
export type CardSetRegistration = v.InferOutput<typeof CardSetRegistrationSchema>;

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

export type CardSetErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_CARD_SET'
  | 'OWNER_SCOPE_MISMATCH'
  | 'THREAD_SCOPE_MISMATCH'
  | 'CANDIDATE_NOT_IN_SET'
  | 'EXCLUDED_CANDIDATE';

export class CardSetError extends Error {
  readonly code: CardSetErrorCode;

  constructor(code: CardSetErrorCode, message: string) {
    super(message);
    this.name = 'CardSetError';
    this.code = code;
  }
}

export type StoredFieldResult =
  | { readonly status: 'known'; readonly observations: readonly ReadonlyStoredObservation[] }
  | {
      readonly status: 'unknown' | 'unsupported' | 'not_applicable';
      readonly reason: string;
    }
  | {
      readonly status: 'error';
      readonly error: Omit<Issue, 'missingFields'> & { readonly missingFields: readonly string[] };
    };

export type CandidateFieldResultRecord = {
  readonly scope: RegistryScope;
  readonly candidateId: CandidateId;
  readonly field: DetailField;
  readonly result: StoredFieldResult;
};

export const AnyStoredFieldResultSchema = AnyFieldResultSchema;
