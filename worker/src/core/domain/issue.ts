import * as v from 'valibot';
import { NonNegativeSafeIntegerSchema, Text } from '@worker/core/domain/primitives';

/**
 * 失敗を分岐する固定コード。再試行可否や欠落の種類を message の文面から推測しない。
 * 引数の不正、根拠不足、鮮度切れ、候補対象外、予算超過は、互いに別コードのまま残す。
 */
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

/**
 * 呼び出し元へ返す失敗。retryable と retryAfterMs が再試行の判断材料で、message は利用者向けの短い説明。
 * missingFields には足りない入力の名前だけを並べ、入力値そのものは載せない。
 */
export const IssueSchema = v.strictObject({
  code: IssueCodeSchema,
  path: v.nullable(v.pipe(v.string(), v.maxLength(240))),
  retryable: v.boolean(),
  retryAfterMs: v.nullable(NonNegativeSafeIntegerSchema),
  message: Text(300),
  missingFields: v.pipe(v.array(Text(80)), v.maxLength(16)),
});
export type Issue = v.InferOutput<typeof IssueSchema>;
