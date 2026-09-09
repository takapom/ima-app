import * as v from 'valibot';
import {
  EvidenceTextSchema,
  ModelActionMetadataSchema,
  ModelDecisionSchema,
  validateModelActionMetadata,
  type ConstraintValidationContext,
  type ModelActionMetadata,
  TurnConstraintError,
} from '@ima/core';

const runtimeFinalMessageSchema = v.strictObject({
  kind: v.literal('final_message'),
  message: EvidenceTextSchema(300),
  metadata: v.optional(ModelActionMetadataSchema),
});

type RuntimeFinalMessageInput = v.InferOutput<typeof runtimeFinalMessageSchema>;
export type RuntimeFinalMessage = {
  readonly kind: 'final_message';
  readonly message: RuntimeFinalMessageInput['message'];
  readonly metadata: ModelActionMetadata;
};

export type RuntimeFinalMessageErrorCode =
  'INVALID_TEXT' | 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'INVALID_METADATA';

const finalMessageErrors = new WeakSet<object>();

export class RuntimeFinalMessageError extends Error {
  readonly code: RuntimeFinalMessageErrorCode;

  constructor(code: RuntimeFinalMessageErrorCode) {
    super(`runtime final message denied: ${code}`);
    this.name = 'RuntimeFinalMessageError';
    this.code = code;
    finalMessageErrors.add(this);
  }
}

export const isRuntimeFinalMessageError = (value: unknown): value is RuntimeFinalMessageError =>
  typeof value === 'object' && value !== null && finalMessageErrors.has(value);

const invalid = (code: RuntimeFinalMessageErrorCode): never => {
  throw new RuntimeFinalMessageError(code);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid('INVALID_JSON');
  }
};

/**
 * Parses the model's terminal text and validates metadata against the exact source turns.
 * Missing metadata is normalized to the Core action metadata empty object. No model text is
 * included in errors, and the returned message is only structurally validated until Core commit.
 */
export const parseRuntimeFinalMessage = (
  text: unknown,
  constraintContext: ConstraintValidationContext,
): RuntimeFinalMessage => {
  if (typeof text !== 'string') return invalid('INVALID_TEXT');
  const parsed = v.safeParse(runtimeFinalMessageSchema, parseJson(text));
  if (!parsed.success) return invalid('INVALID_ENVELOPE');

  let metadata: ModelActionMetadata;
  try {
    metadata = validateModelActionMetadata(parsed.output.metadata ?? {}, constraintContext);
  } catch (error: unknown) {
    if (error instanceof TurnConstraintError) return invalid('INVALID_METADATA');
    throw error;
  }

  const decision = v.safeParse(ModelDecisionSchema, {
    actions: [{ kind: 'final_message', message: parsed.output.message }],
    metadata,
  });
  if (!decision.success) return invalid('INVALID_ENVELOPE');
  const action = decision.output.actions[0];
  if (action === undefined || action.kind !== 'final_message') {
    return invalid('INVALID_ENVELOPE');
  }
  return { kind: 'final_message', message: action.message, metadata: decision.output.metadata };
};
