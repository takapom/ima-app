import * as v from 'valibot';
import { RegistryScopeSchema, type RegistryScope } from '../domain/freshness';
import {
  CandidateIdSchema,
  NonNegativeSafeIntegerSchema,
  ObservationIdSchema,
  OpaqueIdSchema,
  ResponseIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
  Text,
} from '../domain/primitives';

export const CommitReferencesSchema = v.pipe(
  v.strictObject({
    candidateIds: v.pipe(
      v.array(CandidateIdSchema),
      v.maxLength(3),
      v.check((ids) => new Set(ids).size === ids.length, 'candidate IDs must be unique'),
    ),
    observationIds: v.pipe(
      v.array(ObservationIdSchema),
      v.maxLength(256),
      v.check((ids) => new Set(ids).size === ids.length, 'observation IDs must be unique'),
    ),
  }),
);
export type CommitReferences = v.InferOutput<typeof CommitReferencesSchema>;

const CommitExpectedRevisionSchema = v.pipe(
  NonNegativeSafeIntegerSchema,
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);

export const CommitRecordSchema = v.pipe(
  v.strictObject({
    schemaVersion: SchemaVersionSchema,
    scope: RegistryScopeSchema,
    turnId: OpaqueIdSchema,
    idempotencyKey: OpaqueIdSchema,
    responseId: ResponseIdSchema,
    revision: RevisionSchema,
    payloadDigest: Text(128),
    presentation: v.picklist(['keep', 'replace']),
    references: CommitReferencesSchema,
  }),
  v.check(
    (record) =>
      (record.presentation === 'replace' && record.references.candidateIds.length > 0) ||
      (record.presentation === 'keep' && record.references.candidateIds.length === 0),
    'commit references do not match presentation',
  ),
);
export type CommitRecord = v.InferOutput<typeof CommitRecordSchema>;

export const CommitRequestSchema = v.strictObject({
  expectedRevision: CommitExpectedRevisionSchema,
  record: CommitRecordSchema,
});
export type CommitRequest = v.InferOutput<typeof CommitRequestSchema>;

export const CommitReceiptSchema = v.strictObject({
  responseId: ResponseIdSchema,
  revision: RevisionSchema,
  payloadDigest: Text(128),
  presentation: v.picklist(['keep', 'replace']),
  replayed: v.boolean(),
});
export type CommitReceipt = v.InferOutput<typeof CommitReceiptSchema>;

export const CommitConflictSchema = v.strictObject({
  code: v.picklist(['IDEMPOTENCY_CONFLICT', 'STALE_REVISION']),
  message: Text(240),
});
export type CommitConflict = v.InferOutput<typeof CommitConflictSchema>;

export const CommitPortResultSchema = v.union([
  v.strictObject({ status: v.literal('committed'), receipt: CommitReceiptSchema }),
  v.strictObject({ status: v.literal('conflict'), conflict: CommitConflictSchema }),
]);
export type CommitPortResult = v.InferOutput<typeof CommitPortResultSchema>;

/** The adapter supplies a runtime-appropriate digest without bringing crypto into Core. */
export interface CommitHashPort {
  digest(value: string): string | Promise<string>;
}

/** Durable adapters must store only the validated reference record, never the display payload. */
export interface CommitPort {
  /**
   * The adapter compares `expectedRevision` and `record.turnId` with the active turn for the
   * record scope before mutating. A stale turn must return `STALE_REVISION` without a write.
   */
  commit(request: CommitRequest): CommitPortResult | Promise<CommitPortResult>;
}

export type CommitScope = RegistryScope;
