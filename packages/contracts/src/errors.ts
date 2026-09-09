import * as v from 'valibot';
import { OpaqueIdSchema, SchemaVersionSchema, Text } from './common.js';

const publicErrorBase = {
  schemaVersion: SchemaVersionSchema,
  requestId: OpaqueIdSchema,
  message: Text(300),
};

/** Status and code are coupled so clients cannot mistake an auth or expiry error. */
export const PublicErrorSchema = v.variant('status', [
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(400),
    code: v.picklist([
      'INVALID_ARGUMENT',
      'LOCATION_REQUIRED',
      'LOCATION_IMPRECISE',
      'MISSING_CONTEXT',
      'UNSUPPORTED_FIELD',
      'UNSUPPORTED_SCOPE',
    ]),
  }),
  v.strictObject({ ...publicErrorBase, status: v.literal(401), code: v.literal('UNAUTHORIZED') }),
  v.strictObject({ ...publicErrorBase, status: v.literal(403), code: v.literal('FORBIDDEN') }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(404),
    code: v.picklist(['NOT_FOUND', 'UNKNOWN_CANDIDATE']),
  }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(409),
    code: v.picklist([
      'CONFLICT',
      'SCHEMA_MISMATCH',
      'STALE_TURN',
      'CANCELLED',
      'MIXED_TERMINAL_ACTION',
    ]),
  }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(410),
    code: v.picklist(['EXPIRED', 'CURSOR_EXPIRED', 'STALE_EVIDENCE']),
  }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(413),
    code: v.picklist(['PAYLOAD_TOO_LARGE', 'RESULT_TOO_LARGE']),
  }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(415),
    code: v.literal('UNSUPPORTED_MEDIA_TYPE'),
  }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(422),
    code: v.picklist([
      'INVALID_EVIDENCE',
      'MISSING_EVIDENCE',
      'NOT_OPEN',
      'CONSTRAINT_VIOLATION',
      'EXCLUDED_CANDIDATE',
      'BUDGET_EXCEEDED',
    ]),
  }),
  v.strictObject({ ...publicErrorBase, status: v.literal(429), code: v.literal('RATE_LIMITED') }),
  v.strictObject({ ...publicErrorBase, status: v.literal(500), code: v.literal('INTERNAL') }),
  v.strictObject({
    ...publicErrorBase,
    status: v.literal(502),
    code: v.picklist(['PROVIDER_UNAVAILABLE', 'SOURCE_CONFLICT']),
  }),
  v.strictObject({ ...publicErrorBase, status: v.literal(504), code: v.literal('TIMEOUT') }),
]);
export type PublicError = v.InferOutput<typeof PublicErrorSchema>;
