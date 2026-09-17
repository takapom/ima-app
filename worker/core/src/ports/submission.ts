import * as v from 'valibot';
import {
  CandidateIdSchema,
  ObservationIdSchema,
  ResponseIdSchema,
  RevisionSchema,
  SafeIntegerSchema,
  Text,
} from '../domain/primitives';
import type { CancellationToken, ToolExecutionContext } from './context';
import { SubmitCardsInputSchema } from './model';

export const SubmitCardsPortInputSchema = SubmitCardsInputSchema;
export type SubmitCardsPortInput = v.InferOutput<typeof SubmitCardsPortInputSchema>;

const SubmitIssueCodeSchema = v.picklist([
  'INVALID_ARGUMENT',
  'UNKNOWN_CANDIDATE',
  'INVALID_EVIDENCE',
  'MISSING_EVIDENCE',
  'STALE_EVIDENCE',
  'STALE_TURN',
  'CONSTRAINT_VIOLATION',
  'CANCELLED',
  'BUDGET_EXCEEDED',
  'SCHEMA_MISMATCH',
]);
export const SubmitIssueSchema = v.strictObject({
  code: SubmitIssueCodeSchema,
  path: v.nullable(v.pipe(v.string(), v.maxLength(240))),
  candidateId: v.optional(CandidateIdSchema),
  evidenceIds: v.optional(v.pipe(v.array(ObservationIdSchema), v.maxLength(16))),
  message: Text(300),
  missingFields: v.pipe(v.array(Text(80)), v.maxLength(16)),
});
export type SubmitIssue = v.InferOutput<typeof SubmitIssueSchema>;

export const SubmitCardsCommittedSchema = v.strictObject({
  status: v.literal('committed'),
  responseId: ResponseIdSchema,
  revision: RevisionSchema,
  presentation: v.literal('replace'),
  cards: SubmitCardsInputSchema,
});
export type SubmitCardsCommitted = v.InferOutput<typeof SubmitCardsCommittedSchema>;

export const SubmitCardsInvalidSchema = v.pipe(
  v.strictObject({
    status: v.literal('invalid'),
    issues: v.pipe(v.array(SubmitIssueSchema), v.minLength(1), v.maxLength(8)),
    repairable: v.boolean(),
    remainingRepairs: v.pipe(SafeIntegerSchema, v.minValue(0), v.maxValue(2)),
  }),
  v.check((result) => {
    const terminal = result.issues.some(
      (issue) =>
        issue.code === 'STALE_TURN' ||
        issue.code === 'CANCELLED' ||
        issue.code === 'BUDGET_EXCEEDED',
    );
    return (
      (result.remainingRepairs > 0 ? result.repairable : !result.repairable) &&
      (!terminal || (!result.repairable && result.remainingRepairs === 0))
    );
  }, 'invalid submit repair state is inconsistent'),
);
export type SubmitCardsInvalid = v.InferOutput<typeof SubmitCardsInvalidSchema>;

export const SubmitCardsPortResultSchema = v.union([
  SubmitCardsCommittedSchema,
  SubmitCardsInvalidSchema,
]);
export type SubmitCardsPortResult = v.InferOutput<typeof SubmitCardsPortResultSchema>;

/**
 * Runtime adapters implement this boundary. The schema exposes the response ID only as the
 * server-issued result shape; registry checks and atomic commit remain in the owning Harness.
 */
export interface SubmitCardsPort {
  submit(
    input: SubmitCardsPortInput,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<SubmitCardsPortResult>;
}
