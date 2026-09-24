import * as v from 'valibot';
import {
  CandidateIdSchema,
  ObservationIdSchema,
  ResponseIdSchema,
  RevisionSchema,
  SafeIntegerSchema,
  Text,
} from '@worker/domain/primitives';
import type { CancellationToken, ToolExecutionContext } from '@worker/application/ports/context';
import { RespondInputSchema } from '@worker/application/ports/model';

export const RespondPortInputSchema = RespondInputSchema;
export type RespondPortInput = v.InferOutput<typeof RespondPortInputSchema>;

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

/** Asking and answering keep the cards on screen; proposing replaces them. */
export const RespondCommittedSchema = v.pipe(
  v.strictObject({
    status: v.literal('committed'),
    responseId: ResponseIdSchema,
    revision: RevisionSchema,
    kind: v.picklist(['ask', 'answer', 'propose']),
    presentation: v.picklist(['keep', 'replace']),
  }),
  v.check(
    (result) => (result.kind === 'propose') === (result.presentation === 'replace'),
    'respond kind and presentation are inconsistent',
  ),
);
export type RespondCommitted = v.InferOutput<typeof RespondCommittedSchema>;

export const RespondInvalidSchema = v.pipe(
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
  }, 'invalid respond repair state is inconsistent'),
);
export type RespondInvalid = v.InferOutput<typeof RespondInvalidSchema>;

export const RespondPortResultSchema = v.union([RespondCommittedSchema, RespondInvalidSchema]);
export type RespondPortResult = v.InferOutput<typeof RespondPortResultSchema>;

/**
 * Runtime adapters implement this boundary. The schema exposes the response ID only as the
 * server-issued result shape; registry checks and atomic commit remain in the owning Harness.
 */
export interface RespondPort {
  respond(
    input: RespondPortInput,
    execution: ToolExecutionContext,
    cancellation: CancellationToken,
  ): Promise<RespondPortResult>;
}
