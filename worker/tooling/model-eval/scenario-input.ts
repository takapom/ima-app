import * as v from 'valibot';
import {
  AssistantResponseSchema,
  OpaqueIdSchema,
  ThreadTurnRequestSchema,
  type ThreadTurnRequest,
} from '@ima/contracts';
import type { EvaluationCase, JsonValue, ScenarioContext } from './types';
import type { EvaluationTurnSeed } from './turn-plan';

export const MODEL_EVAL_DEVICE_ID = 'model-eval-device' as const;

export type EvaluationCardContext = {
  readonly cardSetId: string;
  readonly candidateOrder: readonly string[];
  readonly selectedCandidateId: string | null;
  readonly promotedCandidateId?: string | null;
  readonly excludeCandidateIds?: readonly string[];
};

export type EvaluationInputBuildFailureCode =
  'INVALID_CARD_CONTEXT' | 'INVALID_TURN_TARGET' | 'UNSUPPORTED_CONDITION';

export type EvaluationInputBuildResult =
  | { readonly ok: true; readonly request: ThreadTurnRequest }
  | { readonly ok: false; readonly code: EvaluationInputBuildFailureCode };

export type EvaluationCardContextResult =
  | { readonly ok: true; readonly context: EvaluationCardContext }
  | { readonly ok: false; readonly code: 'CARD_RESPONSE_UNAVAILABLE' | 'CARD_RESPONSE_INVALID' };

const safeId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/gu, '_');

const idIsValid = (value: string): boolean => v.safeParse(OpaqueIdSchema, value).success;

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

const budgetFor = (
  conditions: readonly { readonly field: string; readonly value: JsonValue }[],
): ThreadTurnRequest['prefs']['budget'] | null => {
  if (conditions.length === 0) return 'normal';
  if (conditions.length !== 1 || conditions[0]?.field !== 'priceLevel') return null;
  const value = conditions[0].value;
  if (value === 'inexpensive' || value === 'cheap') return 'cheap';
  if (value === 'moderate' || value === 'normal') return 'normal';
  if (value === 'any') return 'any';
  return null;
};

const cardContextIsValid = (context: EvaluationCardContext): boolean => {
  if (!idIsValid(context.cardSetId) || context.candidateOrder.length === 0) return false;
  if (
    context.candidateOrder.length > 3 ||
    unique(context.candidateOrder).length !== context.candidateOrder.length
  ) {
    return false;
  }
  if (!context.candidateOrder.every(idIsValid)) return false;
  if (
    context.selectedCandidateId !== null &&
    (!idIsValid(context.selectedCandidateId) ||
      !context.candidateOrder.includes(context.selectedCandidateId))
  ) {
    return false;
  }
  if (
    context.promotedCandidateId !== undefined &&
    context.promotedCandidateId !== null &&
    (!idIsValid(context.promotedCandidateId) ||
      context.candidateOrder[0] !== context.promotedCandidateId)
  ) {
    return false;
  }
  const excluded = context.excludeCandidateIds ?? [];
  return (
    excluded.length <= 50 &&
    unique(excluded).length === excluded.length &&
    excluded.every(idIsValid)
  );
};

const locationFor = (
  context: ScenarioContext,
  now = context.now,
): ThreadTurnRequest['location'] => {
  const policyAllowsLocation = context.locationPolicy === 'available-to-tool';
  const available = policyAllowsLocation && context.locationStatus === 'available';
  const status = available
    ? 'available'
    : context.locationPolicy === 'refuse-to-model' && context.locationStatus === 'available'
      ? 'denied'
      : context.locationStatus;
  return {
    status,
    lat: available ? 35.6595 : null,
    lng: available ? 139.7005 : null,
    accuracyMeters: available ? 40 : null,
    precise: false,
    capturedAt: available ? now : null,
  };
};

/** Extracts only public card metadata from a schema-validated committed response. */
export const cardContextFromResponse = (response: unknown): EvaluationCardContextResult => {
  const parsed = v.safeParse(AssistantResponseSchema, response);
  if (!parsed.success) return { ok: false, code: 'CARD_RESPONSE_INVALID' };
  if (parsed.output.kind !== 'cards' || parsed.output.cardSetId === null) {
    return { ok: false, code: 'CARD_RESPONSE_UNAVAILABLE' };
  }
  const candidateOrder = [
    parsed.output.cards.hero.candidateId,
    ...parsed.output.cards.alts.map((card) => card.candidateId),
  ];
  const context: EvaluationCardContext = {
    cardSetId: parsed.output.cardSetId,
    candidateOrder,
    selectedCandidateId: null,
  };
  return cardContextIsValid(context)
    ? { ok: true, context }
    : { ok: false, code: 'CARD_RESPONSE_INVALID' };
};

/** Builds the exact validated Worker request body; runtime state is supplied separately. */
export const buildEvaluationTurnRequest = (input: {
  readonly evaluationCase: EvaluationCase;
  readonly seed: EvaluationTurnSeed;
  readonly cardContext?: EvaluationCardContext;
  readonly mode?: ThreadTurnRequest['mode'];
}): EvaluationInputBuildResult => {
  const { evaluationCase, seed } = input;
  if (
    seed.target.ownerScopeRef.length === 0 ||
    seed.target.threadId.length === 0 ||
    seed.target.turnId.length === 0 ||
    !Number.isSafeInteger(seed.target.revision) ||
    seed.target.revision < 1
  ) {
    return { ok: false, code: 'INVALID_TURN_TARGET' };
  }
  if (input.cardContext !== undefined && !cardContextIsValid(input.cardContext)) {
    return { ok: false, code: 'INVALID_CARD_CONTEXT' };
  }
  const budget = budgetFor(evaluationCase.context.activeConditions);
  if (budget === null) return { ok: false, code: 'UNSUPPORTED_CONDITION' };
  const turnSuffix = `turn-${seed.index + 1}`;
  const idSuffix = `${safeId(evaluationCase.caseId)}-${turnSuffix}`;
  const cardContext = input.cardContext;
  const request: ThreadTurnRequest = {
    schemaVersion: 'v1',
    requestId: `request-${idSuffix}`,
    turnId: seed.target.turnId,
    revision: seed.target.revision,
    text: seed.text,
    clientNow: seed.clientNow ?? evaluationCase.context.now,
    location: locationFor(evaluationCase.context, seed.clientNow ?? evaluationCase.context.now),
    prefs: {
      areaText: evaluationCase.context.areaText,
      budget,
    },
    ...(cardContext === undefined
      ? {}
      : {
          cardSetId: cardContext.cardSetId,
          selectedCandidateId: cardContext.selectedCandidateId,
          candidateOrder: [...cardContext.candidateOrder],
          ...(cardContext.promotedCandidateId === undefined
            ? {}
            : { promotedCandidateId: cardContext.promotedCandidateId }),
        }),
    excludeCandidateIds: [...(cardContext?.excludeCandidateIds ?? [])],
    mode: input.mode ?? 'search',
    idempotencyKey: `model-eval-${idSuffix}`,
  };
  return v.safeParse(ThreadTurnRequestSchema, request).success
    ? { ok: true, request }
    : { ok: false, code: 'INVALID_TURN_TARGET' };
};
