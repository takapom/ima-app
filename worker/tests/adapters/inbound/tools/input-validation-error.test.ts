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
  openNow: false,
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
    [{ input }, 'metadata'],
    [{ input: { ...input, limit: 100 }, metadata: {} }, 'input.limit'],
    [{ input: { ...input, area: { kind: 'named_area' } }, metadata: {} }, 'input.area.name'],
    [{ input, metadata: {}, [CANARY]: CANARY }, '*'],
    [
      {
        input,
        metadata: { turnConstraints: { changes: [{ sourceTurnId: 'turn-1', quote: CANARY }] } },
      },
      'metadata.turnConstraints.changes.*',
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
    expect(await validate({ input, metadata: {} })).toMatchObject({ success: true });
    expect(
      await validate({ input: { mode: 'continue', cursor: 'cursor-1' }, metadata: {} }),
    ).toMatchObject({ success: true });
  });

  it('advertises the required constraint change to the model and accepts a real change', async () => {
    const schema = asSchema(searchPlacesToolSchema);
    // Only the constraint the connected providers can evidence is advertised.
    expect(await schema.jsonSchema).toMatchObject({
      required: ['input', 'metadata'],
      properties: {
        metadata: {
          properties: {
            turnConstraints: {
              properties: {
                changes: {
                  items: { required: ['sourceTurnId', 'quote', 'minimumStayMinutes'] },
                },
              },
            },
          },
        },
      },
    });
    expect(
      await validate({
        input,
        metadata: {
          turnConstraints: {
            changes: [{ minimumStayMinutes: 45, sourceTurnId: 'turn-1', quote: '45分は居たい' }],
          },
        },
      }),
    ).toMatchObject({ success: true });
  });

  it('does not advertise a constraint the providers cannot evidence', async () => {
    const schema = asSchema(searchPlacesToolSchema);
    const json = JSON.stringify(await schema.jsonSchema);
    expect(json).not.toContain('maxWalkMinutes');
    expect(json).not.toContain('homeStationRef');
    // The wire schema only shapes what the model is offered. Core still parses the
    // wider constraint contract, so capability enforcement belongs to the turn
    // factory, which drops an unsupported change before it reaches the conditions.
    expect(
      await validate({
        input,
        metadata: {
          turnConstraints: {
            changes: [{ maxWalkMinutes: 15, sourceTurnId: 'turn-1', quote: '徒歩15分以内' }],
          },
        },
      }),
    ).toMatchObject({ success: true });
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
