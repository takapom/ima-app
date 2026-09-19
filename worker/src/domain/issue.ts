import * as v from 'valibot';
import { NonNegativeSafeIntegerSchema, Text } from '@worker/domain/primitives';

export const IssueCodeSchema = v.picklist([
  'INVALID_ARGUMENT',
  'UNKNOWN_CANDIDATE',
  'CURSOR_EXPIRED',
  'INVALID_EVIDENCE',
  'LOCATION_REQUIRED',
  'LOCATION_IMPRECISE',
  'MISSING_CONTEXT',
  'UNSUPPORTED_FIELD',
  'UNSUPPORTED_SCOPE',
  'TIMEOUT',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'SOURCE_CONFLICT',
  'MISSING_EVIDENCE',
  'STALE_EVIDENCE',
  'NOT_OPEN',
  'CONSTRAINT_VIOLATION',
  'EXCLUDED_CANDIDATE',
  'CANCELLED',
  'BUDGET_EXCEEDED',
  'STALE_TURN',
  'MIXED_TERMINAL_ACTION',
  'RESULT_TOO_LARGE',
  'SCHEMA_MISMATCH',
]);
export type IssueCode = v.InferOutput<typeof IssueCodeSchema>;

export const IssueSchema = v.strictObject({
  code: IssueCodeSchema,
  path: v.nullable(v.pipe(v.string(), v.maxLength(240))),
  retryable: v.boolean(),
  retryAfterMs: v.nullable(NonNegativeSafeIntegerSchema),
  message: Text(300),
  missingFields: v.pipe(v.array(Text(80)), v.maxLength(16)),
});
export type Issue = v.InferOutput<typeof IssueSchema>;
