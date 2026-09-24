import * as v from 'valibot';
import {
  CandidateIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  ObservationIdSchema,
  Text,
} from '@worker/domain/primitives';
import { ObservationContextSchema } from '@worker/domain/evidence/freshness';
import { RetentionMetadataSchema } from '@worker/domain/evidence/retention';

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
