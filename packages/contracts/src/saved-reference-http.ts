import * as v from 'valibot';
import { OpaqueIdSchema, RequestIdSchema, RevisionSchema, SchemaVersionSchema } from './common';

export const SavedReferencePathSchema = v.strictObject({
  savedPlaceRef: OpaqueIdSchema,
});

/** Explicit saving accepts only the public candidate reference and current thread revision. */
export const SavedReferenceCreateRequestSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  candidateId: OpaqueIdSchema,
  revision: RevisionSchema,
  idempotencyKey: OpaqueIdSchema,
});
export type SavedReferenceCreateRequest = v.InferOutput<typeof SavedReferenceCreateRequestSchema>;

export const SavedReferenceCreateResponseSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  candidateId: OpaqueIdSchema,
  savedPlaceRef: OpaqueIdSchema,
});
export type SavedReferenceCreateResponse = v.InferOutput<typeof SavedReferenceCreateResponseSchema>;

/** DELETE is idempotent and carries its own request idempotency key in the JSON body. */
export const SavedReferenceDeleteRequestSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  requestId: RequestIdSchema,
  idempotencyKey: OpaqueIdSchema,
});
export type SavedReferenceDeleteRequest = v.InferOutput<typeof SavedReferenceDeleteRequestSchema>;
