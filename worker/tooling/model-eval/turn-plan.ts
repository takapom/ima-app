import * as v from 'valibot';
import { AssistantResponseSchema } from '@ima/contracts';

export type EvaluationTurnTarget = {
  readonly ownerScopeRef: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly revision: number;
};

export type EvaluationTurnSeed = {
  readonly caseId: string;
  readonly index: number;
  readonly text: string;
  readonly target: EvaluationTurnTarget;
  /** Fixture-only clock override; production live cases use the scenario clock. */
  readonly clientNow?: string;
};

export type EvaluationTurnPlanFailure = {
  readonly ok: false;
  readonly code: 'MULTI_TURN_SEED_UNAVAILABLE' | 'MULTI_TURN_RESPONSE_INVALID';
};

export type EvaluationTurnPlanResult =
  { readonly ok: true; readonly seed: EvaluationTurnSeed } | EvaluationTurnPlanFailure;

const validTarget = (value: EvaluationTurnTarget): boolean =>
  value.ownerScopeRef.length > 0 &&
  value.ownerScopeRef.length <= 128 &&
  value.threadId.length > 0 &&
  value.threadId.length <= 128 &&
  value.turnId.length > 0 &&
  value.turnId.length <= 128 &&
  Number.isSafeInteger(value.revision) &&
  value.revision > 0;

const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/gu, '_');

const nextTurnId = (caseId: string, index: number): string =>
  `model-eval-${safeId(caseId)}-turn-${index + 1}`;

/** Creates only the first request; later revisions come from the validated response. */
export const createEvaluationTurnSeed = (input: {
  readonly caseId: string;
  readonly userTurns: readonly string[];
  readonly target: EvaluationTurnTarget;
  readonly clientNow?: string;
}): EvaluationTurnPlanResult => {
  const text = input.userTurns[0];
  if (
    typeof input.caseId !== 'string' ||
    input.caseId.length === 0 ||
    typeof text !== 'string' ||
    text.length === 0 ||
    !validTarget(input.target)
  ) {
    return { ok: false, code: 'MULTI_TURN_SEED_UNAVAILABLE' };
  }
  return {
    ok: true,
    seed: {
      caseId: input.caseId,
      index: 0,
      text,
      target: input.target,
      ...(input.clientNow === undefined ? {} : { clientNow: input.clientNow }),
    },
  };
};

/**
 * Advances a same-DO evaluation only from a schema-validated public response.
 * A reference-only replay or a mismatched identity cannot seed another turn.
 */
export const advanceEvaluationTurn = (
  current: EvaluationTurnSeed,
  response: unknown,
  nextText: string,
  nextClientNow?: string,
): EvaluationTurnPlanResult => {
  if (nextText.length === 0 || !validTarget(current.target)) {
    return { ok: false, code: 'MULTI_TURN_SEED_UNAVAILABLE' };
  }
  const parsed = v.safeParse(AssistantResponseSchema, response);
  if (!parsed.success) return { ok: false, code: 'MULTI_TURN_RESPONSE_INVALID' };
  const previous = parsed.output;
  if (
    previous.threadId !== current.target.threadId ||
    previous.turnId !== current.target.turnId ||
    previous.revision !== current.target.revision + 1
  ) {
    return { ok: false, code: 'MULTI_TURN_RESPONSE_INVALID' };
  }
  const index = current.index + 1;
  const target = {
    ownerScopeRef: current.target.ownerScopeRef,
    threadId: current.target.threadId,
    turnId: nextTurnId(current.caseId, index),
    revision: previous.revision,
  };
  if (!validTarget(target)) return { ok: false, code: 'MULTI_TURN_SEED_UNAVAILABLE' };
  const clientNow = nextClientNow ?? current.clientNow;
  return {
    ok: true,
    seed: {
      caseId: current.caseId,
      index,
      text: nextText,
      target,
      ...(clientNow === undefined ? {} : { clientNow }),
    },
  };
};
