import type { RespondInvalid } from '@worker/application/ports/submission';
import type { RespondKind } from '@worker/application/ports/model';

/**
 * A rejected respond is the one failure a user sees only as "no answer": the model is
 * told why, but nothing else records it. These fields are structural — issue codes,
 * schema paths, field names and Core-authored messages — so no provider content,
 * generated text, coordinate or secret reaches the log.
 */
export type RuntimeSubmitRejectionIssue = {
  readonly code: string;
  readonly path: string | null;
  readonly missingFields: readonly string[];
  readonly message: string;
};

export type RuntimeSubmitRejection = {
  readonly repairable: boolean;
  readonly remainingRepairs: number;
  /** Distinct candidates named by the issues; the IDs themselves stay out of the log. */
  readonly candidates: number;
  readonly issues: readonly RuntimeSubmitRejectionIssue[];
};

export type RuntimeSubmitRejectionWriter = (rejection: RuntimeSubmitRejection) => void;

export const runtimeSubmitRejectionFor = (result: RespondInvalid): RuntimeSubmitRejection => ({
  repairable: result.repairable,
  remainingRepairs: result.remainingRepairs,
  candidates: new Set(
    result.issues.flatMap((issue) => (issue.candidateId === undefined ? [] : [issue.candidateId])),
  ).size,
  issues: result.issues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    missingFields: issue.missingFields,
    message: issue.message,
  })),
});

const writeRuntimeSubmitRejection: RuntimeSubmitRejectionWriter = (rejection) => {
  console.warn(JSON.stringify({ event: 'respond_invalid', ...rejection }));
};

/**
 * A turn that ends without a commit looks identical to a provider outage from the
 * outside. Recording which public operations ran separates "the model never tried to
 * respond" from "the respond was refused". Only operation names, counts and the committed
 * kind (ask, answer or propose) are kept.
 */
export type RuntimeTurnOutcome = {
  readonly committed: boolean;
  readonly operations: Readonly<Record<string, number>>;
  readonly kind?: RespondKind;
};

export type RuntimeTurnOutcomeWriter = (outcome: RuntimeTurnOutcome) => void;

const writeRuntimeTurnOutcome: RuntimeTurnOutcomeWriter = (outcome) => {
  console.info(JSON.stringify({ event: 'turn_outcome', ...outcome }));
};

export const observeRuntimeTurnOutcome = (
  outcome: RuntimeTurnOutcome,
  writer: RuntimeTurnOutcomeWriter = writeRuntimeTurnOutcome,
): void => {
  try {
    writer(outcome);
  } catch {
    // Diagnostics are best effort and never alter the runtime operation.
  }
};

/**
 * The model ended its turn without calling respond, although every step requires a tool call.
 * Nothing is committed and the turn degrades to "no terminal action", so this reason code is the
 * only record of it. Only the fixed reason crosses; no model text is logged.
 */
export type RuntimeTerminalFormatReason = 'TEXT_WITHOUT_RESPOND' | 'EMPTY_STEP';

export type RuntimeTerminalFormatWriter = (reason: RuntimeTerminalFormatReason) => void;

const writeRuntimeTerminalFormatFailure: RuntimeTerminalFormatWriter = (reason) => {
  console.warn(JSON.stringify({ event: 'respond_missing', reason }));
};

/** Best effort: a diagnostic must never change the degraded turn it observes. */
export const observeRuntimeTerminalFormatFailure = (
  reason: RuntimeTerminalFormatReason,
  writer: RuntimeTerminalFormatWriter = writeRuntimeTerminalFormatFailure,
): void => {
  try {
    writer(reason);
  } catch {
    // Diagnostics are best effort and never alter the runtime operation.
  }
};

/** Best effort: a diagnostic must never change the respond result it observes. */
export const observeRuntimeSubmitRejection = (
  result: RespondInvalid,
  writer: RuntimeSubmitRejectionWriter = writeRuntimeSubmitRejection,
): void => {
  try {
    writer(runtimeSubmitRejectionFor(result));
  } catch {
    // Diagnostics are best effort and never alter the runtime operation.
  }
};
