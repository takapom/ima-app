import * as v from 'valibot';
import { IsoTimestampSchema, RevisionSchema } from '@worker/domain/primitives';
import { JourneyRecordSchema } from '@worker/domain/travel/journey';

export const JOURNEY_DATASET_SCHEMA_VERSION = 'v1' as const;
export const JOURNEY_DATASET_MAX_RECORDS = 5_000;

export const JourneyDatasetEnvelopeSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(JOURNEY_DATASET_SCHEMA_VERSION),
    revision: RevisionSchema,
    importedAt: IsoTimestampSchema,
    sourceRevision: v.nullable(RevisionSchema),
    records: v.pipe(v.array(JourneyRecordSchema), v.maxLength(JOURNEY_DATASET_MAX_RECORDS)),
  }),
  v.check(
    (dataset) =>
      new Set(dataset.records.map((record) => record.journeyRef)).size === dataset.records.length,
    'journey references must be unique within a dataset',
  ),
);
export type JourneyDatasetEnvelope = v.InferOutput<typeof JourneyDatasetEnvelopeSchema>;

export const JourneyImportInputSchema = v.strictObject({
  records: v.pipe(v.array(v.unknown()), v.maxLength(JOURNEY_DATASET_MAX_RECORDS)),
});
export type JourneyImportInput = v.InferOutput<typeof JourneyImportInputSchema>;

export type JourneyDatasetParseResult =
  { readonly ok: true; readonly dataset: JourneyDatasetEnvelope } | { readonly ok: false };

export const parseJourneyDataset = (input: unknown): JourneyDatasetParseResult => {
  const parsed = v.safeParse(JourneyDatasetEnvelopeSchema, input);
  return parsed.success ? { ok: true, dataset: parsed.output } : { ok: false };
};
