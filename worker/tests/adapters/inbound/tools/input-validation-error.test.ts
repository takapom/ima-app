import { asSchema, InvalidToolInputError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  safeToolInputValidationMessage,
  toolInputInvalidFields,
} from '@worker/runtime/model/tool-input-error';
import { searchPlacesToolSchema } from '@worker/adapters/in/tools/schemas';

const CANARY = 'SECRET_INPUT_CANARY';
const input = {
  mode: 'search',
  query: CANARY,
  area: { kind: 'named_area', name: CANARY },
  limit: 5,
  excludeCandidateIds: [],
};
const validate = async (value: unknown) => {
  const schema = asSchema(searchPlacesToolSchema);
  if (schema.validate === undefined) throw new Error('Missing validator');
  return schema.validate(value);
};

describe('safe tool validation feedback', () => {
  it.each([
    [{}, 'input'],
    [{ input: { ...input, limit: 100 } }, 'input.limit'],
    [{ input: { ...input, area: { kind: 'named_area' } } }, 'input.area.name'],
    [{ input, [CANARY]: CANARY }, '*'],
    [
      {
        input,
        metadata: { turnConstraints: { changes: [{ sourceTurnId: 'turn-1', quote: CANARY }] } },
      },
      '*',
    ],
  ])('identifies invalid fields without including values or unknown keys', async (value, field) => {
    const result = await validate(value);
    expect(result?.success).toBe(false);
    if (result === undefined || result.success) throw new Error('Expected invalid input');
    expect(toolInputInvalidFields(result.error)).toContain(field);
    expect(result.error.message).not.toContain(CANARY);
    const wrapped = new InvalidToolInputError({
      toolName: 'search_places',
      toolInput: JSON.stringify(value),
      cause: new Error(`SDK error with raw input ${CANARY}. ${result.error.message}`),
    });
    expect(safeToolInputValidationMessage(wrapped.message)).toBe(result.error.message);
  });

  it('accepts both search and continuation envelopes', async () => {
    expect(await validate({ input })).toMatchObject({ success: true });
    expect(await validate({ input: { mode: 'continue', cursor: 'cursor-1' } })).toMatchObject({
      success: true,
    });
  });

  it('advertises only the input envelope and rejects the removed metadata field', async () => {
    const schema = asSchema(searchPlacesToolSchema);
    expect(await schema.jsonSchema).toMatchObject({
      required: ['input'],
      additionalProperties: false,
    });
    const json = JSON.stringify(await schema.jsonSchema);
    expect(json).not.toContain('metadata');
    expect(json).not.toContain('turnConstraints');
    expect(json).not.toContain('travelContext');
    expect(await validate({ input, metadata: {} })).toMatchObject({ success: false });
  });

  it.each([
    CANARY,
    `Tool input validation failed. Invalid fields: ${CANARY}`,
    'Tool input validation failed. Invalid fields: ',
    `Tool input validation failed. Invalid fields: ${Array<string>(9).fill('input').join(', ')}`,
  ])('rejects unrecognized or oversized error details', (message) => {
    expect(safeToolInputValidationMessage(message)).toBeUndefined();
  });
});
