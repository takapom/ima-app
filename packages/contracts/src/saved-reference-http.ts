import * as v from 'valibot';
import {
  OpaqueIdSchema,
  RequestIdSchema,
  RevisionSchema,
  SchemaVersionSchema,
} from '@contracts/common';
import type { ParseResult } from '@contracts/response';

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

const parseSchema = <Schema extends v.GenericSchema>(
  schema: Schema,
  input: unknown,
): ParseResult<v.InferOutput<Schema>> => {
  const parsed = v.safeParse(schema, input);
  return parsed.success
    ? { success: true, data: parsed.output }
    : { success: false, issues: parsed.issues.map((issue) => issue.message) };
};

export const parseSavedReferencePath = (
  input: unknown,
): ParseResult<v.InferOutput<typeof SavedReferencePathSchema>> =>
  parseSchema(SavedReferencePathSchema, input);

export const parseSavedReferenceCreateRequest = (
  input: unknown,
): ParseResult<SavedReferenceCreateRequest> =>
  parseSchema(SavedReferenceCreateRequestSchema, input);

export const parseSavedReferenceCreateResponse = (
  input: unknown,
): ParseResult<SavedReferenceCreateResponse> =>
  parseSchema(SavedReferenceCreateResponseSchema, input);

export const parseSavedReferenceDeleteRequest = (
  input: unknown,
): ParseResult<SavedReferenceDeleteRequest> =>
  parseSchema(SavedReferenceDeleteRequestSchema, input);
