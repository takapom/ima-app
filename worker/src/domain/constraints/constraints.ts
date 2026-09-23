import * as v from 'valibot';

/** Metadata attached to a model action; it is not a fourth tool or a preference mutation. */
export const ModelActionMetadataSchema = v.strictObject({});
export type ModelActionMetadata = v.InferOutput<typeof ModelActionMetadataSchema>;
