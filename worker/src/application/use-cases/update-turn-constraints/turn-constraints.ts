import * as v from 'valibot';
import {
  ModelActionMetadataSchema,
  TurnConstraintsSchema,
  type ModelActionMetadata,
  type TurnConstraints,
} from '@worker/domain/constraints/constraints';
import { OpaqueIdSchema, SafeIntegerSchema, Text, TurnIdSchema } from '@worker/domain/primitives';

const ConstraintMinutesSchema = v.pipe(SafeIntegerSchema, v.minValue(1), v.maxValue(180));

/** Effective conditions for the current turn; this value is never written to saved preferences. */
export const TurnConditionValuesSchema = v.strictObject({
  maxWalkMinutes: v.nullable(ConstraintMinutesSchema),
  homeStationRef: v.nullable(OpaqueIdSchema),
  minimumStayMinutes: v.nullable(ConstraintMinutesSchema),
});
export type TurnConditionValues = v.InferOutput<typeof TurnConditionValuesSchema>;

export const OriginalTurnSchema = v.strictObject({
  threadId: OpaqueIdSchema,
  turnId: TurnIdSchema,
  text: Text(500),
});
export type OriginalTurn = v.InferOutput<typeof OriginalTurnSchema>;

const ConstraintValidationContextSchema = v.pipe(
  v.strictObject({
    threadId: OpaqueIdSchema,
    originalTurns: v.pipe(v.array(OriginalTurnSchema), v.maxLength(32)),
  }),
  v.check(
    (context) =>
      new Set(context.originalTurns.map((turn) => `${turn.threadId}:${turn.turnId}`)).size ===
      context.originalTurns.length,
    'original turns must be unique',
  ),
);

export type ConstraintValidationContext = v.InferOutput<typeof ConstraintValidationContextSchema>;

export type TurnConstraintErrorCode =
  | 'INVALID_PROPOSAL'
  | 'INVALID_CONTEXT'
  | 'SOURCE_TURN_NOT_FOUND'
  | 'SOURCE_THREAD_MISMATCH'
  | 'QUOTE_NOT_FOUND';

export class TurnConstraintError extends Error {
  readonly code: TurnConstraintErrorCode;

  constructor(code: TurnConstraintErrorCode, message: string) {
    super(message);
    this.name = 'TurnConstraintError';
    this.code = code;
  }
}

const parseContext = (context: unknown): ConstraintValidationContext => {
  const parsed = v.safeParse(ConstraintValidationContextSchema, context);
  if (!parsed.success) throw new TurnConstraintError('INVALID_CONTEXT', 'turn context is invalid');
  return parsed.output;
};

/**
 * Validates model metadata against the exact current-thread source text. It never mutates or
 * returns saved preferences, so accepting a proposal cannot silently change standing settings.
 */
export const validateTurnConstraintsProposal = (
  proposal: unknown,
  context: unknown,
): TurnConstraints => {
  const parsed = v.safeParse(TurnConstraintsSchema, proposal);
  if (!parsed.success) {
    throw new TurnConstraintError('INVALID_PROPOSAL', 'turn constraint proposal is invalid');
  }
  const source = parseContext(context);
  for (const change of parsed.output.changes) {
    const matchingTurns = source.originalTurns.filter(
      (turn) => turn.turnId === change.sourceTurnId,
    );
    if (matchingTurns.length === 0) {
      throw new TurnConstraintError('SOURCE_TURN_NOT_FOUND', 'source turn is not in this thread');
    }
    const sourceTurn = matchingTurns[0];
    if (sourceTurn === undefined || sourceTurn.threadId !== source.threadId) {
      throw new TurnConstraintError(
        'SOURCE_THREAD_MISMATCH',
        'source turn belongs to another thread',
      );
    }
    if (!sourceTurn.text.includes(change.quote)) {
      throw new TurnConstraintError('QUOTE_NOT_FOUND', 'quote is not an exact source substring');
    }
  }
  return parsed.output;
};

/** Validates the action envelope while keeping an omitted metadata field optional. */
export const validateModelActionMetadata = (
  metadata: unknown,
  context: unknown,
): ModelActionMetadata => {
  const parsed = v.safeParse(ModelActionMetadataSchema, metadata);
  if (!parsed.success) {
    throw new TurnConstraintError('INVALID_PROPOSAL', 'model action metadata is invalid');
  }
  if (parsed.output.turnConstraints === undefined) return parsed.output;
  return {
    turnConstraints: validateTurnConstraintsProposal(parsed.output.turnConstraints, context),
  };
};

/**
 * Applies a validated proposal to this turn's effective conditions only.
 * The input is copied and no saved-preference object is accepted or mutated.
 */
export const applyTurnConstraintsForTurn = (
  current: unknown,
  proposal: unknown,
  context: unknown,
): TurnConditionValues => {
  const parsedCurrent = v.safeParse(TurnConditionValuesSchema, current);
  if (!parsedCurrent.success) {
    throw new TurnConstraintError('INVALID_CONTEXT', 'current turn conditions are invalid');
  }
  const validated = validateTurnConstraintsProposal(proposal, context);
  const next: TurnConditionValues = { ...parsedCurrent.output };
  for (const change of validated.changes) {
    if (change.maxWalkMinutes !== undefined) next.maxWalkMinutes = change.maxWalkMinutes;
    if (change.homeStationRef !== undefined) next.homeStationRef = change.homeStationRef;
    if (change.minimumStayMinutes !== undefined) {
      next.minimumStayMinutes = change.minimumStayMinutes;
    }
  }
  return next;
};
