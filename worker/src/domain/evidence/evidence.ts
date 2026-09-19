import * as v from 'valibot';
import {
  CandidateIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  ObservationIdSchema,
  Text,
} from '@worker/domain/primitives';
import { ObservationContextSchema } from '@worker/domain/evidence/freshness';
import {
  AttributionSchema,
  RetentionMetadataSchema,
  retentionDoesNotExceed,
} from '@worker/domain/evidence/retention';

export const SourceRefSchema = v.strictObject({
  provider: Text(80),
  recordRef: Text(512),
  attribution: v.nullable(Text(160)),
  publicUrl: v.nullable(v.pipe(HttpsUrlSchema, v.maxLength(2048))),
});
export type SourceRef = v.InferOutput<typeof SourceRefSchema>;

export const ObservationSchema = <T extends v.GenericSchema>(value: T) =>
  v.pipe(
    v.strictObject({
      observationId: ObservationIdSchema,
      candidateId: CandidateIdSchema,
      field: Text(80),
      value,
      basis: v.picklist(['provider_reported', 'computed']),
      fetchedAt: IsoTimestampSchema,
      sourceUpdatedAt: v.nullable(IsoTimestampSchema),
      expiresAt: IsoTimestampSchema,
      freshUntil: v.optional(IsoTimestampSchema),
      contextKey: Text(256),
      context: v.optional(ObservationContextSchema),
      sources: v.pipe(v.array(SourceRefSchema), v.minLength(1), v.maxLength(8)),
      retention: RetentionMetadataSchema,
    }),
    v.check(
      (observation) =>
        Date.parse(observation.fetchedAt ?? '') <= Date.parse(observation.expiresAt ?? '') &&
        (observation.freshUntil === undefined ||
          Date.parse(observation.fetchedAt ?? '') <= Date.parse(observation.freshUntil)),
      'observation expiry must be at or after fetch time',
    ),
  );
export const AnyObservationSchema = ObservationSchema(v.unknown());
type ObservationOutput<T> = v.InferOutput<
  ReturnType<typeof ObservationSchema<v.GenericSchema<unknown, T>>>
>;
export type Observation<T> = ObservationOutput<T>;

export const EvidenceRefSchema = v.strictObject({
  evidenceId: ObservationIdSchema,
  observationId: ObservationIdSchema,
  candidateId: CandidateIdSchema,
  field: Text(80),
  attribution: v.nullable(AttributionSchema),
  retention: RetentionMetadataSchema,
});
export type EvidenceRef = v.InferOutput<typeof EvidenceRefSchema>;

const EvidenceBasisSchema = v.picklist(['grounded', 'inference', 'conversational']);
export type EvidenceBasis = v.InferOutput<typeof EvidenceBasisSchema>;

export const EvidenceTextSchema = (maxLength: number) =>
  v.pipe(
    v.strictObject({
      text: Text(maxLength),
      evidenceIds: v.pipe(v.array(ObservationIdSchema), v.maxLength(16)),
      basis: EvidenceBasisSchema,
    }),
    v.check(
      (value) =>
        uniqueIds(value.evidenceIds) &&
        (value.basis !== 'grounded' || value.evidenceIds.length > 0),
      'grounded text requires evidence',
    ),
  );

const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;

export const EvidenceTextWithPolicySchema = (maxLength: number) =>
  v.pipe(
    v.strictObject({
      text: Text(maxLength),
      evidenceIds: v.pipe(v.array(ObservationIdSchema), v.maxLength(16)),
      evidence: v.pipe(v.array(EvidenceRefSchema), v.maxLength(16)),
      basis: EvidenceBasisSchema,
      retention: RetentionMetadataSchema,
    }),
    v.check((value) => {
      const evidenceIds = new Set(value.evidence.map((item) => item.evidenceId));
      const allSourcesAllowStorage = value.evidence.every(
        (item) => item.retention.retentionDecision === 'allow',
      );
      return (
        uniqueIds(value.evidenceIds) &&
        uniqueIds(value.evidence.map((item) => item.evidenceId)) &&
        value.evidenceIds.every((id) => evidenceIds.has(id)) &&
        value.evidence.every((item) => value.evidenceIds.includes(item.evidenceId)) &&
        (value.basis !== 'grounded' || value.evidenceIds.length > 0) &&
        (value.evidence.length === 0 ||
          value.retention.retentionDecision !== 'allow' ||
          allSourcesAllowStorage) &&
        value.evidence.every((item) => retentionDoesNotExceed(value.retention, item.retention))
      );
    }, 'evidence IDs and retention must be coherent'),
  );
