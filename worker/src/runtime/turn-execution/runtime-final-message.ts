import * as v from 'valibot';
import { Text } from '@worker/domain/primitives';

const runtimeFinalMessageSchema = v.strictObject({
  kind: v.literal('final_message'),
  message: Text(300),
});

type RuntimeFinalMessageInput = v.InferOutput<typeof runtimeFinalMessageSchema>;
export type RuntimeFinalMessage = {
  readonly kind: 'final_message';
  readonly message: RuntimeFinalMessageInput['message'];
};

export type RuntimeFinalMessageErrorCode = 'INVALID_TEXT' | 'INVALID_JSON' | 'INVALID_ENVELOPE';

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
 * Parses the model's terminal text. No model text is included in errors, and the returned
 * message is only structurally validated until Core commit.
 */
export const parseRuntimeFinalMessage = (text: unknown): RuntimeFinalMessage => {
  if (typeof text !== 'string') return invalid('INVALID_TEXT');
  const parsed = v.safeParse(runtimeFinalMessageSchema, parseJson(text));
  if (!parsed.success) return invalid('INVALID_ENVELOPE');
  return { kind: 'final_message', message: parsed.output.message };
};
